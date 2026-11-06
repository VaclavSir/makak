import type { Sbx } from "../tools/index.ts";
import type { McpHealth } from "./health.ts";
import type { McpRegistrations } from "./registrations.ts";

// Loading the servers registered with sbx into sandboxes, and taking them
// out again. A load outlasts stopping and starting the sandbox, so each is
// done once. Which sandbox has which server is recorded by the lifecycle.

export interface McpLoads {
  /** Why these servers can't be loaded now, if they can't. */
  problems: (servers: readonly string[]) => Promise<string[]>;
  load: (server: string, sandbox: string) => Promise<void>;
  unload: (server: string, sandbox: string) => Promise<void>;
}

export interface McpLoadsOptions {
  /** The errors the server gave meanwhile, which explain sbx's failures. */
  health?: Pick<McpHealth, "errorSince">;
  now?: () => number;
  registrations: Pick<McpRegistrations, "status">;
  sbx: Pick<Sbx, "mcpLoad" | "mcpUnload">;
  servers: readonly { name: string }[];
}

/** A server couldn't be loaded, with the reason the server gave. */
export class LoadError extends Error {
  override name = "LoadError";
}

export const createMcpLoads = ({
  health,
  now = Date.now,
  registrations,
  sbx,
  servers,
}: McpLoadsOptions): McpLoads => ({
  load: async (server, sandbox) => {
    const started = now();
    try {
      await sbx.mcpLoad(server, sandbox);
    } catch (error) {
      // sbx says only that connecting failed; the server says why.
      const refusal = health?.errorSince(server, started);
      if (refusal === undefined) {
        throw error;
      }
      throw new LoadError(
        `sbx couldn't load ${server} into ${sandbox}: connecting to it, the server answered ${refusal.message}`,
        { cause: error }
      );
    }
  },

  problems: async (chosen) => {
    const unknown = chosen.filter(
      (name) => !servers.some((server) => server.name === name)
    );
    if (unknown.length > 0) {
      return unknown.map(
        (name) => `There is no MCP server named ${name} in the config.`
      );
    }
    if (chosen.length === 0) {
      return [];
    }
    const statuses = await registrations.status();
    return chosen.flatMap((name) => {
      const status = statuses.get(name);
      if (status === undefined || status.state === "ready") {
        return [];
      }
      return [
        status.state === "missing"
          ? `${name} isn't registered with sbx. Register it on the MCP servers page first.`
          : `${name} is registered with sbx, but can't be used: ${status.detail ?? "sbx says so"}`,
      ];
    });
  },

  unload: (server, sandbox) => sbx.mcpUnload(server, sandbox),
});
