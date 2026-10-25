import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import * as z from "zod";

import { createJsonFile } from "../json-file.ts";

// What the MCP proxy keeps: a token per (server, sandbox), and the tools
// allowed with "always allow". In `<stateDir>/mcp.json`.

const registrationSchema = z.object({
  createdAt: z.string(),
  /** The sandbox's name when registered, as in the endpoint's path. */
  sandbox: z.string().min(1),
  sandboxId: z.string().min(1),
  server: z.string().min(1),
});

const fileSchema = z.object({
  /** Per server, on top of the config's `allow`. */
  allowed: z.record(z.string(), z.array(z.string())).default({}),
  /** Keyed by the token's SHA-256. The token itself is never stored. */
  registrations: z.record(z.string(), registrationSchema).default({}),
});

export type Registration = z.output<typeof registrationSchema>;

export interface McpStore {
  /**
   * A new token for the server and sandbox, replacing any earlier one: a
   * sandbox has one token per server, so the token alone identifies both.
   */
  register: (
    server: string,
    sandbox: { id: string; name: string },
    now?: Date
  ) => Promise<string>;
  /** Whose token this is, if anyone's. */
  identify: (token: string) => Promise<Registration | undefined>;
  registrations: () => Promise<Registration[]>;
  unregister: (server: string, sandboxId: string) => Promise<void>;
  /** The tools allowed with "always allow", sorted. */
  allowed: (server: string) => Promise<string[]>;
  allow: (server: string, tool: string) => Promise<void>;
  disallow: (server: string, tool: string) => Promise<void>;
}

// Hashed, so the file reveals no token, and a lookup's timing nothing either.
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const without = (
  registrations: Record<string, Registration>,
  server: string,
  sandboxId: string
) =>
  Object.fromEntries(
    Object.entries(registrations).filter(
      ([, entry]) => entry.server !== server || entry.sandboxId !== sandboxId
    )
  );

export const createMcpStore = (stateDir: string): McpStore => {
  const file = createJsonFile(path.join(stateDir, "mcp.json"), fileSchema);

  return {
    allow: (server, tool) =>
      file.update((state) => {
        const tools = new Set(state.allowed[server]).add(tool);
        state.allowed[server] = [...tools].toSorted();
      }),
    allowed: async (server) => {
      const state = await file.read();
      return (state.allowed[server] ?? []).toSorted();
    },
    disallow: (server, tool) =>
      file.update((state) => {
        state.allowed[server] = (state.allowed[server] ?? []).filter(
          (each) => each !== tool
        );
      }),
    identify: async (token) => {
      const state = await file.read();
      return Object.hasOwn(state.registrations, digest(token))
        ? state.registrations[digest(token)]
        : undefined;
    },
    register: async (server, sandbox, now = new Date()) => {
      const token = randomBytes(32).toString("base64url");
      await file.update((state) => {
        state.registrations = without(state.registrations, server, sandbox.id);
        state.registrations[digest(token)] = {
          createdAt: now.toISOString(),
          sandbox: sandbox.name,
          sandboxId: sandbox.id,
          server,
        };
      });
      return token;
    },
    registrations: async () => {
      const state = await file.read();
      return Object.values(state.registrations);
    },
    unregister: (server, sandboxId) =>
      file.update((state) => {
        state.registrations = without(state.registrations, server, sandboxId);
      }),
  };
};
