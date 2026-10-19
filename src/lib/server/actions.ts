import { fail } from "@sveltejs/kit";
import type { ActionFailure } from "@sveltejs/kit";
import * as z from "zod";

import { userMessage } from "#server/lifecycle.ts";

// Helpers for form actions. Server-only: `$lib/server` is never bundled for
// the browser.

/** The env file hashes a plan or confirmation was shown with. */
export const hashesSchema = z.array(z.string());

/** A form field holding JSON, parsed with a schema, or undefined if invalid. */
export const jsonField = <T>(
  schema: z.ZodType<T>,
  value: FormDataEntryValue | null
): T | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(String(value));
  } catch {
    return undefined;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : undefined;
};

export type Attempt<T> =
  | { ok: true; value: T }
  | { failure: ActionFailure<{ message: string }>; ok: false };

/**
 * Runs a change, turning the errors meant for the user, such as a failed
 * `sbx` command, into a 400 with their message. Anything else is a bug and
 * is thrown.
 */
export const attempt = async <T>(
  run: () => Promise<T>
): Promise<Attempt<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const message = userMessage(error);
    if (message === undefined) {
      throw error;
    }
    return { failure: fail(400, { message }), ok: false };
  }
};

export const INCOMPLETE = { message: "The form is incomplete." };
