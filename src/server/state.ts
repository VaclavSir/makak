import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import * as z from "zod";

// What the Panel knows about a sandbox that sbx doesn't. Keyed by sandbox
// id, not name: a name can be reused by an unrelated sandbox after `sbx rm`.

export const MAX_NOTES_LENGTH = 10_000;

const recordSchema = z.object({
  notes: z.string().max(MAX_NOTES_LENGTH).default(""),
});

const fileSchema = z.object({
  sandboxes: z.record(z.string(), recordSchema).default({}),
});

type StateFile = z.output<typeof fileSchema>;
export type SandboxRecord = z.output<typeof recordSchema>;

export interface SandboxStore {
  get: (id: string) => Promise<SandboxRecord>;
  setNotes: (id: string, notes: string) => Promise<void>;
}

export class StateError extends Error {
  override name = "StateError";
}

/**
 * Use this, not `instanceof`: SvelteKit routes get their own copy of this
 * module, so the store in the Panel context throws a different class.
 */
export const isStateError = (error: unknown): error is StateError =>
  error instanceof Error && error.name === "StateError";

const EMPTY_RECORD: SandboxRecord = { notes: "" };

/** Waits for a promise, ignoring how it ended. */
const settle = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch {
    // Already reported to whoever was waiting for it.
  }
};

/**
 * A JSON file, written whole: through a temporary file and a rename, so a
 * crash never leaves it half-written. Writes are queued, never interleaved.
 * Nothing is cached: every read and every write starts from the file, so hand
 * edits are kept, and a file that can't be parsed is reported, never
 * overwritten. It is small, and read once per page load.
 */
export const createSandboxStore = (stateDir: string): SandboxStore => {
  const file = path.join(stateDir, "sandboxes.json");
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<StateFile> => {
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sandboxes: {} };
      }
      throw error;
    }
    try {
      return fileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new StateError(
        `${file} is damaged; fix or remove it: ${(error as Error).message}`,
        { cause: error }
      );
    }
  };

  const save = async (state: StateFile) => {
    await mkdir(stateDir, { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
  };

  const apply = async (
    previous: Promise<unknown>,
    change: (state: StateFile) => void
  ) => {
    await settle(previous);
    const state = await read();
    change(state);
    await save(state);
  };

  const update = (change: (state: StateFile) => void): Promise<void> => {
    const next = apply(queue, change);
    queue = settle(next);
    return next;
  };

  return {
    get: async (id) => {
      const state = await read();
      return state.sandboxes[id] ?? { ...EMPTY_RECORD };
    },
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
