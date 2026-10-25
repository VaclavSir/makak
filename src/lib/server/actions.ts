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
 * Runs something, turning the errors meant for the user, such as a failed
 * `sbx` command, into their message. Anything else is a bug and is thrown.
 */
export const orUserError = async <T>(
  run: () => Promise<T>
): Promise<{ message: string; ok: false } | { ok: true; value: T }> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const message = userMessage(error);
    if (message === undefined) {
      throw error;
    }
    return { message, ok: false };
  }
};

/** Like `orUserError`, for a form action: the message comes with a 400. */
export const attempt = async <T>(
  run: () => Promise<T>
): Promise<Attempt<T>> => {
  const result = await orUserError(run);
  return result.ok
    ? result
    : { failure: fail(400, { message: result.message }), ok: false };
};

export const INCOMPLETE = { message: "The form is incomplete." };

/** A text field, or undefined when it is missing. */
export const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};
