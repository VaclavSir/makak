import { ConfigError } from "../config.ts";
import type { Config } from "../config.ts";
import type { McpServer } from "./proxy.ts";

/**
 * The configured servers, with each header and each local server's variable
 * read from the environment where the config says so. Every missing variable
 * is reported at once, at start.
 */
export const resolveServers = (
  mcp: Config["mcp"],
  env: NodeJS.ProcessEnv = process.env
): McpServer[] => {
  const missing: string[] = [];
  /** Each value, read from the environment where the config says so. */
  const resolve = (
    values: Record<string, string | { env: string }>,
    what: (name: string) => string
  ) =>
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => {
        if (typeof value === "string") {
          return [name, value];
        }
        const resolved = env[value.env];
        if (resolved === undefined || resolved === "") {
          missing.push(`${value.env} (${what(name)})`);
        }
        return [name, resolved ?? ""];
      })
    );
  const servers = mcp.servers.map((server): McpServer => ({
    allow: server.allow,
    headers: resolve(
      server.headers,
      (name) => `the ${name} header of ${server.name}`
    ),
    holdMs: (server.holdSeconds ?? mcp.holdSeconds) * 1000,
    local:
      server.command === undefined
        ? undefined
        : {
            args: server.args,
            command: server.command,
            cwd: server.dir,
            env: resolve(
              server.env,
              (name) => `the ${name} variable of ${server.name}`
            ),
          },
    name: server.name,
    oauth: server.oauth,
    url: server.url,
  }));
  if (missing.length > 0) {
    throw new ConfigError(
      `The MCP servers need these environment variables, which are not set: ${missing.join(", ")}`
    );
  }
  return servers;
};
