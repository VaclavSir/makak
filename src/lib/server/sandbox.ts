import { error as httpError, fail } from "@sveltejs/kit";

import { INCOMPLETE } from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";
import type { Target } from "#server/lifecycle.ts";
import type { Sandbox } from "#server/tools/index.ts";

// Finding the sandbox a page or form is about. Server-only.

/** The sandbox with this name, or a 404 page; a 503 when sbx can't list. */
export const findSandbox = async (name: string): Promise<Sandbox> => {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await getPanelContext().sandboxes.find(name);
  } catch (error) {
    httpError(503, `Can't list sandboxes: ${(error as Error).message}`);
  }
  if (sandbox === undefined) {
    httpError(404, `There is no sandbox named ${name}.`);
  }
  return sandbox;
};

/** The sandbox a form was submitted for: its name, and the id the page showed. */
export const targetOf = (form: FormData, name: string): Target | undefined => {
  const id = form.get("id");
  return typeof id === "string" ? { id, name } : undefined;
};

export const REPLACED = {
  message:
    "This sandbox was replaced by a new one with the same name. Reload the page.",
};

/**
 * The sandbox a form was submitted for, if the name still belongs to the one
 * the page showed, or the failure to return.
 */
export const sandboxOf = async (form: FormData, name: string) => {
  const target = targetOf(form, name);
  if (target === undefined) {
    return { failure: fail(400, INCOMPLETE), ok: false } as const;
  }
  const sandbox = await findSandbox(name);
  return sandbox.id === target.id
    ? ({ ok: true, sandbox } as const)
    : ({ failure: fail(409, REPLACED), ok: false } as const);
};
