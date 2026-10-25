import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type * as z from "zod";

export class StateError extends Error {
  override name = "StateError";
}

/**
 * Use this, not `instanceof`: SvelteKit routes get their own copy of this
 * module, so the stores in the Panel context throw a different class.
 */
export const isStateError = (error: unknown): error is StateError =>
  error instanceof Error && error.name === "StateError";

/** Waits for a promise, ignoring how it ended. */
const settle = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch {
    // Already reported to whoever was waiting for it.
  }
};

export interface JsonFile<T> {
  read: () => Promise<T>;
  /** Reads the file, changes it and writes it back, after earlier updates. */
  update: (change: (value: T) => void) => Promise<void>;
}

/**
 * A JSON file of the Panel's own, written whole: through a temporary file and
 * a rename, so a crash never leaves it half-written. Writes are queued, never
 * interleaved. Nothing is cached: every read and every write starts from the
 * file, so hand edits are kept, and a file that can't be parsed is reported,
 * never overwritten. The files are small.
 */
export const createJsonFile = <S extends z.ZodType>(
  file: string,
  schema: S
): JsonFile<z.output<S>> => {
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<z.output<S>> => {
    let text: string | undefined;
    try {
      text = await readFile(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    try {
      return schema.parse(text === undefined ? {} : JSON.parse(text));
    } catch (error) {
      throw new StateError(
        `${file} is damaged; fix or remove it: ${(error as Error).message}`,
        { cause: error }
      );
    }
  };

  const save = async (value: z.output<S>) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
  };

  const apply = async (
    previous: Promise<unknown>,
    change: (value: z.output<S>) => void
  ) => {
    await settle(previous);
    const value = await read();
    change(value);
    await save(value);
  };

  return {
    read,
    update: (change) => {
      const next = apply(queue, change);
      queue = settle(next);
      return next;
    },
  };
};
