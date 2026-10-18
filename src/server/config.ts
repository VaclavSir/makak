import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as z from "zod";

export const DEFAULT_CONFIG_PATH = path.join(
  homedir(),
  ".makak",
  "config.json"
);

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// At least two labels, and an alphabetic last label, which rules out IP literals and `localhost`.
const HOSTNAME = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]*[a-z0-9]$`, "u");
const SUFFIX = new RegExp(`^(?:\\.${LABEL})+$`, "u");

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

const configSchema = z
  .strictObject({
    envDir: hostPath.prefault("~/makak/envs"),
    handoffsDir: hostPath.prefault("~/makak/handoffs"),
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
            cert: hostPath.prefault("~/.makak/tls/panel.pem"),
            key: hostPath.prefault("~/.makak/tls/panel-key.pem"),
          })
          .prefault({}),
      })
      .prefault({}),
    proxy: z
      .strictObject({
        listeners: z
          .array(
            z.strictObject({
              port,
              upstream: z.array(port).min(1),
            })
          )
          .default([]),
        suffixes: z
          .array(z.string().regex(SUFFIX, "must look like .makak.test"))
          .min(1)
          .default([".makak.test"]),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    const { hostname } = config.panel;
    for (const [index, suffix] of config.proxy.suffixes.entries()) {
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
