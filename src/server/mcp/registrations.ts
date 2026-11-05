import type { Sbx } from "../tools/index.ts";
import type { McpHealth } from "./health.ts";
import type { OAuth } from "./oauth.ts";
import { MCP_PATH } from "./proxy.ts";
import type { McpStore } from "./store.ts";

// Registering each server's endpoint with sbx, once, under the server's own
// name, so any sandbox can load it. The registration sends the server's
// token, kept in a global sbx secret: sbx fills the header's placeholder.

/**
 * - `missing`: not registered with sbx.
 * - `ready`: registered, and sbx can use it.
 * - `unusable`: registered, but sbx says it can't use it, e.g. its secret is
 *   missing.
 * - `stale`: registered, but the Panel holds no token for it, so its calls
 *   are refused.
 */
export type RegistrationState = "missing" | "ready" | "stale" | "unusable";

export interface RegistrationStatus {
  /** What's wrong and how to fix it, for any state but `ready`. */
  detail: string | undefined;
  state: RegistrationState;
}

export interface McpRegistrations {
  /** Each configured server's registration, by name. */
  status: () => Promise<Map<string, RegistrationStatus>>;
  /** Registers the server, replacing any registration of that name. */
  register: (server: string) => Promise<void>;
  /**
   * Removes the registration and its secret, and revokes the token. Returns
   * the commands that remove what sbx refused to.
   */
  unregister: (server: string) => Promise<string[]>;
}

export interface McpRegistrationsOptions {
  /** The errors the server gave meanwhile, which explain sbx's failures. */
  health?: Pick<McpHealth, "errorSince">;
  now?: () => number;
  oauth: Pick<OAuth, "status">;
  /** The Panel's origin, which serves the endpoints. */
  origin: string;
  sbx: Pick<Sbx, "mcpAdd" | "mcpList" | "mcpRm" | "secretRm" | "secretSet">;
  servers: readonly { name: string; oauth?: unknown }[];
  store: Pick<McpStore, "issue" | "issued" | "revoke">;
}

/** Registering or unregistering couldn't be done, with why. */
export class RegistrationError extends Error {
  override name = "RegistrationError";
}

/** The global sbx secret holding a server's token. */
export const tokenSecret = (server: string): string => `mcp:${server}:token`;

/** Lets a cleanup fail without hiding the error that called for it. */
const quietly = async (cleanup: () => Promise<unknown>) => {
  try {
    await cleanup();
  } catch {
    // The earlier error is what the user needs to see.
  }
};

export const createMcpRegistrations = ({
  health,
  now = Date.now,
  oauth,
  origin,
  sbx,
  servers,
  store,
}: McpRegistrationsOptions): McpRegistrations => {
  const configured = (name: string) => {
    const server = servers.find((each) => each.name === name);
    if (server === undefined) {
      throw new RegistrationError(
        `There is no MCP server named ${name} in the config.`
      );
    }
    return server;
  };

  const listed = async (name: string) => {
    const listing = await sbx.mcpList();
    return listing.find((each) => each.name === name);
  };

  return {
    register: async (name) => {
      const server = configured(name);
      if (server.oauth !== undefined) {
        const { signedIn } = await oauth.status(name);
        if (!signedIn) {
          throw new RegistrationError(
            `Sign in to ${name} first: sbx connects to the server when it registers it.`
          );
        }
      }
      if ((await listed(name)) !== undefined) {
        await sbx.mcpRm(name);
      }
      const token = await store.issue(name);
      const started = now();
      try {
        // Stored first: sbx connects to the endpoint when it registers it.
        await sbx.secretSet(tokenSecret(name), token);
        await sbx.mcpAdd({
          // A placeholder, which sbx fills from the secret; not a template.
          // oxlint-disable-next-line no-template-curly-in-string -- sbx fills it
          headers: ["Authorization: Bearer ${token}"],
          name,
          url: `${origin}${MCP_PATH}${encodeURIComponent(name)}`,
        });
      } catch (error) {
        await quietly(() => store.revoke(name));
        await quietly(() => sbx.secretRm(tokenSecret(name)));
        // sbx says only that connecting failed; the server says why.
        const refusal = health?.errorSince(name, started);
        if (refusal === undefined) {
          throw error;
        }
        throw new RegistrationError(
          `sbx couldn't register ${name}: connecting to it, the server answered ${refusal.message}`,
          { cause: error }
        );
      }
    },

    status: async () => {
      const [listing, issued] = await Promise.all([
        sbx.mcpList(),
        store.issued(),
      ]);
      const statuses = new Map<string, RegistrationStatus>();
      for (const { name } of servers) {
        const entry = listing.find((each) => each.name === name);
        if (entry === undefined) {
          statuses.set(name, { detail: undefined, state: "missing" });
        } else if (entry.status !== "ready") {
          statuses.set(name, {
            detail: `sbx reports it as ${entry.status}${entry.detail === undefined ? "" : ` (${entry.detail})`}. Registering it again sets its secret anew.`,
            state: "unusable",
          });
        } else if (issued.includes(name)) {
          statuses.set(name, { detail: undefined, state: "ready" });
        } else {
          statuses.set(name, {
            detail:
              "The Panel holds no token for this registration, so its calls are refused. Register it again.",
            state: "stale",
          });
        }
      }
      return statuses;
    },

    unregister: async (name) => {
      configured(name);
      // Revoked first: the token is useless even if sbx keeps it.
      await store.revoke(name);
      const left: string[] = [];
      let entry: Awaited<ReturnType<typeof listed>>;
      try {
        entry = await listed(name);
        if (entry !== undefined) {
          await sbx.mcpRm(name);
        }
      } catch {
        left.push(`sbx mcp rm --force ${name}`);
      }
      // sbx has said so when the secret is missing; removing it would fail.
      if (entry?.status !== "needs-secret") {
        try {
          await sbx.secretRm(tokenSecret(name));
        } catch {
          // Without a registration, most likely there was no secret either.
          if (entry !== undefined) {
            left.push(`sbx secret rm --force ${tokenSecret(name)}`);
          }
        }
      }
      return left;
    },
  };
};
