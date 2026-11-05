import path from "node:path";

import * as z from "zod";

import { createJsonFile, StateError } from "./json-file.ts";

export { isStateError, StateError } from "./json-file.ts";

// What the Panel knows about a sandbox that sbx doesn't. Keyed by sandbox
// id, not name: a name can be reused by an unrelated sandbox after `sbx rm`.

export const MAX_NOTES_LENGTH = 10_000;

/** How the Panel created a sandbox, replayed for every `sbx env` command. */
const envSchema = z.object({
  args: z.record(z.string(), z.string()),
  createdAt: z.string(),
  files: z.array(z.string()).min(1),
  name: z.string().min(1),
});

const recordSchema = z.object({
  /** Set when the Panel created the sandbox: it is managed. */
  env: envSchema.optional(),
  /**
   * The MCP servers the Panel loaded into it, as far as the Panel knows: sbx
   * can't say. Kept after removal, for creating it again from its config.
   */
  mcp: z.array(z.string()).default([]),
  notes: z.string().max(MAX_NOTES_LENGTH).default(""),
});

const fileSchema = z.object({
  sandboxes: z.record(z.string(), recordSchema).default({}),
});

export type SandboxRecord = z.output<typeof recordSchema>;
export type EnvRecord = z.output<typeof envSchema>;

export interface SandboxStore {
  get: (id: string) => Promise<SandboxRecord>;
  /** Every record, by sandbox id, including those of removed sandboxes. */
  list: () => Promise<Record<string, SandboxRecord>>;
  setNotes: (id: string, notes: string) => Promise<void>;
  setEnv: (id: string, env: EnvRecord) => Promise<void>;
  /** Adds a server to, or takes one off, the servers loaded into it. */
  setLoaded: (id: string, server: string, loaded: boolean) => Promise<void>;
  /** Deletes the record, notes included. */
  forget: (id: string) => Promise<void>;
}

const EMPTY_RECORD: SandboxRecord = { mcp: [], notes: "" };

/** In `<stateDir>/sandboxes.json`; see `createJsonFile` for how it is kept. */
export const createSandboxStore = (stateDir: string): SandboxStore => {
  const file = createJsonFile(
    path.join(stateDir, "sandboxes.json"),
    fileSchema
  );
  const { update } = file;

  return {
    forget: (id) =>
      update((state) => {
        state.sandboxes = Object.fromEntries(
          Object.entries(state.sandboxes).filter(([key]) => key !== id)
        );
      }),
    get: async (id) => {
      const state = await file.read();
      return state.sandboxes[id] ?? { ...EMPTY_RECORD };
    },
    list: async () => {
      const state = await file.read();
      return state.sandboxes;
    },
    setEnv: (id, env) =>
      update((state) => {
        state.sandboxes[id] = { ...EMPTY_RECORD, ...state.sandboxes[id], env };
      }),
    setLoaded: (id, server, loaded) =>
      update((state) => {
        const record = state.sandboxes[id] ?? { ...EMPTY_RECORD };
        const servers = new Set(record.mcp);
        if (loaded) {
          servers.add(server);
        } else {
          servers.delete(server);
        }
        record.mcp = [...servers].toSorted();
        state.sandboxes[id] = record;
      }),
    setNotes: (id, notes) => {
      if (notes.length > MAX_NOTES_LENGTH) {
        return Promise.reject(
          new StateError(`Notes are limited to ${MAX_NOTES_LENGTH} characters`)
        );
      }
      return update((state) => {
        const record = state.sandboxes[id] ?? { ...EMPTY_RECORD };
        record.notes = notes;
        state.sandboxes[id] = record;
      });
    },
  };
};
