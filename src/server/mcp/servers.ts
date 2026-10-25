import { ConfigError } from "../config.ts";
import type { Config } from "../config.ts";
import type { McpServer } from "./proxy.ts";

/**
 * The configured servers, with each header read from the environment where
 * the config says so. Every missing variable is reported at once, at start.
 */
export const resolveServers = (
  mcp: Config["mcp"],
  env: NodeJS.ProcessEnv = process.env
): McpServer[] => {
  const missing: string[] = [];
  const servers = mcp.servers.map((server) => ({
    allow: server.allow,
    headers: Object.fromEntries(
      Object.entries(server.headers).map(([name, value]) => {
        if (typeof value === "string") {
          return [name, value];
        }
        const resolved = env[value.env];
        if (resolved === undefined || resolved === "") {
          missing.push(`${value.env} (the ${name} header of ${server.name})`);
        }
        return [name, resolved ?? ""];
      })
    ),
    holdMs: (server.holdSeconds ?? mcp.holdSeconds) * 1000,
    name: server.name,
    url: server.url,
  }));
  if (missing.length > 0) {
    throw new ConfigError(
      `The MCP servers need these environment variables, which are not set: ${missing.join(", ")}`
    );
  }
  return servers;
};
