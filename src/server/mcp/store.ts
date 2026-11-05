import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import * as z from "zod";

import { createJsonFile } from "../json-file.ts";

// What the MCP proxy keeps: a token per server, which the sbx MCP gateway
// sends, and the tools allowed with "always allow". In `<stateDir>/mcp.json`.

const tokenSchema = z.object({
  createdAt: z.string(),
  server: z.string().min(1),
});

const fileSchema = z.object({
  /** Per server, on top of the config's `allow`. */
  allowed: z.record(z.string(), z.array(z.string())).default({}),
  /** Keyed by the token's SHA-256. The token itself is never stored. */
  tokens: z.record(z.string(), tokenSchema).default({}),
});

export interface McpStore {
  /** A new token for the server, replacing its earlier one. */
  issue: (server: string, now?: Date) => Promise<string>;
  /** The server this token was issued for, if any. */
  identify: (token: string) => Promise<string | undefined>;
  revoke: (server: string) => Promise<void>;
  /** The servers with a token, sorted. */
  issued: () => Promise<string[]>;
  /** The tools allowed with "always allow", sorted. */
  allowed: (server: string) => Promise<string[]>;
  allow: (server: string, tool: string) => Promise<void>;
  disallow: (server: string, tool: string) => Promise<void>;
}

// Hashed, so the file reveals no token, and a lookup's timing nothing either.
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const without = (
  tokens: Record<string, z.output<typeof tokenSchema>>,
  server: string
) =>
  Object.fromEntries(
    Object.entries(tokens).filter(([, entry]) => entry.server !== server)
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
      return Object.hasOwn(state.tokens, digest(token))
        ? state.tokens[digest(token)]?.server
        : undefined;
    },
    issue: async (server, now = new Date()) => {
      const token = randomBytes(32).toString("base64url");
      await file.update((state) => {
        state.tokens = without(state.tokens, server);
        state.tokens[digest(token)] = { createdAt: now.toISOString(), server };
      });
      return token;
    },
    issued: async () => {
      const state = await file.read();
      const servers = new Set(
        Object.values(state.tokens).map((entry) => entry.server)
      );
      return [...servers].toSorted();
    },
    revoke: (server) =>
      file.update((state) => {
        state.tokens = without(state.tokens, server);
      }),
  };
};
