import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as z from "zod";

import { DNS_LABEL, sandboxPattern } from "../lib/proxy-urls.ts";

export const DEFAULT_CONFIG_PATH = path.join(homedir(), "makak", "config.json");

// At least two labels, and an alphabetic last label, which rules out IP literals and `localhost`.
const HOSTNAME = new RegExp(
  `^(?:${DNS_LABEL}\\.)+[a-z][a-z0-9-]*[a-z0-9]$`,
  "u"
);
const SUFFIX = new RegExp(`^(?:\\.${DNS_LABEL})+$`, "u");

const expandHome = (value: string): string =>
  value === "~" || value.startsWith("~/")
    ? path.join(homedir(), value.slice(1))
    : value;

/**
 * The last two labels. A naive stand-in for the public suffix list, which is
 * enough to keep the Panel off the sandboxes' domain for the suffixes we use.
 */
const registrableDomain = (hostname: string): string =>
  hostname.split(".").slice(-2).join(".");

const hostPath = z
  .string()
  .min(1)
  .transform(expandHome)
  .refine((value) => path.isAbsolute(value), {
    message: "must be an absolute path or start with ~/",
  });

const port = z.number().int().min(1).max(65_535);

// No hyphens: registrations are named `<server>-<sandbox>`, and sandbox names
// may have them, so a hyphen in a server name would make the split ambiguous.
const MCP_SERVER_NAME = /^[a-z][a-z0-9_]*$/u;

const holdSeconds = z.number().int().min(1).max(86_400);

/** A header for the upstream server: literal, or read from the Panel's environment. */
const headerValue = z.union([
  z.string(),
  z.strictObject({ env: z.string().min(1) }),
]);

const isRegExp = (source: string) => {
  try {
    sandboxPattern(source);
    return true;
  } catch {
    return false;
  }
};

const configSchema = z
  .strictObject({
    envDir: hostPath.prefault("~/makak/envs"),
    handoffsDir: hostPath.prefault("~/makak/handoffs"),
    mcp: z
      .strictObject({
        holdSeconds: holdSeconds.default(240),
        servers: z
          .array(
            z.strictObject({
              allow: z.array(z.string().min(1)).default([]),
              headers: z.record(z.string().min(1), headerValue).default({}),
              holdSeconds: holdSeconds.optional(),
              name: z
                .string()
                .regex(
                  MCP_SERVER_NAME,
                  "must be lower-case letters, digits and underscores, starting with a letter"
                ),
              url: z.url({ protocol: /^https?$/u }),
            })
          )
          .default([]),
      })
      .prefault({}),
    panel: z
      .strictObject({
        hostname: z
          .string()
          .regex(
            HOSTNAME,
            "must be a lower-case DNS name such as makakctl.test"
          )
          .default("makakctl.test"),
        port: port.default(7443),
        tls: z
          .strictObject({
            cert: hostPath.prefault("~/makak/tls/panel.pem"),
            key: hostPath.prefault("~/makak/tls/panel-key.pem"),
          })
          .prefault({}),
      })
      .prefault({}),
    proxy: z
      .strictObject({
        elevate: z
          .array(
            z.strictObject({
              port: port.optional(),
              sandbox: z.string().refine(isRegExp, {
                message: "must be a valid regular expression",
              }),
            })
          )
          .default([]),
        listeners: z
          .array(
            z.strictObject({
              port,
              upstream: z.array(port).min(1),
              websocket: z.boolean().default(false),
            })
          )
          .default([]),
        suffixes: z
          .array(z.string().regex(SUFFIX, "must look like .makak.test"))
          .min(1)
          .default([".makak.test"]),
        tls: z
          .strictObject({
            cert: hostPath.prefault("~/makak/tls/sandboxes.pem"),
            key: hostPath.prefault("~/makak/tls/sandboxes-key.pem"),
          })
          .prefault({}),
      })
      .prefault({}),
    runs: z
      .strictObject({
        projects: z
          .array(
            z.strictObject({
              commands: z
                .array(
                  z.strictObject({
                    command: z.string().min(1),
                    label: z.string().min(1),
                  })
                )
                .min(1),
              path: hostPath,
            })
          )
          .default([]),
      })
      .prefault({}),
    ssh: z
      .strictObject({
        hostSuffix: z
          .string()
          .regex(SUFFIX, "must look like .sbx")
          .default(".sbx"),
      })
      .prefault({}),
    stateDir: hostPath.prefault("~/makak/state"),
  })
  .superRefine((config, ctx) => {
    const { hostname } = config.panel;
    for (const [index, suffix] of config.proxy.suffixes.entries()) {
      if (config.proxy.suffixes.indexOf(suffix) !== index) {
        ctx.addIssue({
          code: "custom",
          message: `the suffix ${suffix} is listed twice`,
          path: ["proxy", "suffixes", index],
        });
      }
      const domain = suffix.slice(1);
      if (hostname === domain || hostname.endsWith(suffix)) {
        ctx.addIssue({
          code: "custom",
          message: `the Panel hostname ${hostname} must not be under the sandbox suffix ${suffix}`,
          path: ["proxy", "suffixes", index],
        });
      } else if (registrableDomain(hostname) === registrableDomain(domain)) {
        ctx.addIssue({
          code: "custom",
          message: `the Panel hostname ${hostname} must be on a different domain than the sandbox suffix ${suffix}`,
          path: ["proxy", "suffixes", index],
        });
      }
    }

    // A rule names the sandbox port an address resolves to. One that no
    // listener can resolve to, such as the 443 in the address, never matches.
    const sandboxPorts = new Set(
      config.proxy.listeners.flatMap(({ upstream }) => upstream)
    );
    for (const [index, rule] of config.proxy.elevate.entries()) {
      if (rule.port !== undefined && !sandboxPorts.has(rule.port)) {
        ctx.addIssue({
          code: "custom",
          message: `port ${rule.port} is not in any listener's upstream list, so the rule never applies; it must name the sandbox port, such as 8000, not the port in the address`,
          path: ["proxy", "elevate", index, "port"],
        });
      }
    }

    const names = config.mcp.servers.map(({ name }) => name);
    for (const [index, name] of names.entries()) {
      if (names.indexOf(name) !== index) {
        ctx.addIssue({
          code: "custom",
          message: `the MCP server ${name} is listed twice`,
          path: ["mcp", "servers", index, "name"],
        });
      }
    }

    const seen = new Set([config.panel.port]);
    for (const [index, listener] of config.proxy.listeners.entries()) {
      if (seen.has(listener.port)) {
        ctx.addIssue({
          code: "custom",
          message: `port ${listener.port} is already used by the Panel or another listener`,
          path: ["proxy", "listeners", index, "port"],
        });
      }
      seen.add(listener.port);
    }
  });

export type Config = z.output<typeof configSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const parseConfig = (input: unknown, source = "config"): Config => {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      `Invalid ${source}:\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
};

/**
 * Loads the config file. A missing default file means all defaults; a missing
 * file the user named is an error, so a typo never silently runs on defaults.
 */
export const loadConfig = async (explicitFile?: string): Promise<Config> => {
  const file = explicitFile ?? DEFAULT_CONFIG_PATH;
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (explicitFile !== undefined) {
      throw new ConfigError(`Config file not found: ${file}`, { cause: error });
    }
    return parseConfig({}, file);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${String(error)}`);
  }
  return parseConfig(json, file);
};
