import { error as httpError, fail, redirect } from "@sveltejs/kit";

import { SANDBOX_PAGE } from "#lib/dependencies.ts";
import {
  attempt,
  hashesSchema,
  INCOMPLETE,
  jsonField,
} from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";
import type { Inspection, Target } from "#server/lifecycle.ts";
import { isStateError, MAX_NOTES_LENGTH } from "#server/state.ts";
import type { Sandbox } from "#server/tools/index.ts";

import type { Actions, PageServerLoad } from "./$types";

const findSandbox = async (name: string) => {
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

// Not rerun by the sidebar's polling, which would reset the notes being
// typed. The page takes live status from the layout's list instead.
export const load: PageServerLoad = async ({ depends, params }) => {
  depends(SANDBOX_PAGE);
  const { config, lifecycle } = getPanelContext();
  const sandbox = await findSandbox(params.name);
  let inspection: Inspection;
  try {
    inspection = await lifecycle.inspect(sandbox);
  } catch (error) {
    if (isStateError(error)) {
      httpError(500, error.message);
    }
    throw error;
  }
  const { elevate, listeners, suffixes } = config.proxy;
  return {
    ...inspection,
    maxNotesLength: MAX_NOTES_LENGTH,
    proxy: { elevate, listeners, suffixes },
    sandbox,
    sshSuffix: config.ssh.hostSuffix,
  };
};

/** The sandbox a form was submitted for: its name, and the id the page showed. */
const targetOf = (form: FormData, name: string): Target | undefined => {
  const id = form.get("id");
  return typeof id === "string" ? { id, name } : undefined;
};

/** Hashes as the page saw the env files; none when it used no plan. */
const hashesOf = (form: FormData) =>
  jsonField(hashesSchema, form.get("hashes") ?? "[]");

const REPLACED = {
  message:
    "This sandbox was replaced by a new one with the same name. Reload the page.",
};

/**
 * The sandbox a Git action was submitted for, if the name still belongs to
 * the one the page showed, or the failure to return.
 */
const gitTargetOf = async (form: FormData, name: string) => {
  const target = targetOf(form, name);
  if (target === undefined) {
    return { failure: fail(400, INCOMPLETE), ok: false } as const;
  }
  const sandbox = await findSandbox(name);
  return sandbox.id === target.id
    ? ({ ok: true, sandbox } as const)
    : ({ failure: fail(409, REPLACED), ok: false } as const);
};

/** Like `gitTargetOf`, with the branch and SHA the page showed. */
const branchActionOf = async (form: FormData, name: string) => {
  const branch = form.get("branch");
  const sha = form.get("sha");
  if (typeof branch !== "string" || typeof sha !== "string") {
    return { failure: fail(400, INCOMPLETE), ok: false } as const;
  }
  const target = await gitTargetOf(form, name);
  return target.ok ? { ...target, branch, sha } : target;
};

export const actions: Actions = {
  bringToHost: async ({ params, request }) => {
    const action = await branchActionOf(await request.formData(), params.name);
    if (!action.ok) {
      return action.failure;
    }
    const { branch, sandbox, sha } = action;
    const result = await attempt(() =>
      getPanelContext().sandboxGit.bringToHost(sandbox, branch, sha)
    );
    return result.ok
      ? { git: `Brought ${branch} to the host.` }
      : result.failure;
  },

  notes: async ({ params, request }) => {
    const sandbox = await findSandbox(params.name);
    const form = await request.formData();
    const id = form.get("id");
    const notes = form.get("notes");
    if (typeof id !== "string" || typeof notes !== "string") {
      return fail(400, { message: "The form is incomplete." });
    }
    // The name may now belong to a new sandbox. Notes go to the one the
    // page showed, or nowhere.
    if (id !== sandbox.id) {
      return fail(409, {
        message:
          "This sandbox was replaced by a new one with the same name. Copy your text before loading it.",
      });
    }
    // Browsers submit textarea line breaks as CRLF.
    const normalized = notes.replaceAll("\r\n", "\n");
    if (normalized.length > MAX_NOTES_LENGTH) {
      return fail(400, {
        message: `Notes are limited to ${MAX_NOTES_LENGTH} characters.`,
      });
    }
    try {
      await getPanelContext().store.setNotes(sandbox.id, normalized);
    } catch (error) {
      if (isStateError(error)) {
        return fail(500, { message: error.message });
      }
      throw error;
    }
    return { saved: true };
  },

  planStart: async ({ params, request }) => {
    const target = targetOf(await request.formData(), params.name);
    if (target === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().lifecycle.planStart(target)
    );
    if (!result.ok) {
      return result.failure;
    }
    const { hashes, output, warnings } = result.value;
    return { plan: { hashes, output, warnings } };
  },

  push: async ({ params, request }) => {
    const form = await request.formData();
    const action = await branchActionOf(form, params.name);
    if (!action.ok) {
      return action.failure;
    }
    const { branch, sandbox, sha } = action;
    // Present only for a force push: origin's SHA as the page showed it.
    const lease = form.get("lease");
    const result = await attempt(() =>
      getPanelContext().sandboxGit.push(
        sandbox,
        branch,
        sha,
        typeof lease === "string" ? lease : undefined
      )
    );
    return result.ok ? { git: `Pushed ${branch} to origin.` } : result.failure;
  },

  refresh: async ({ params, request }) => {
    const target = await gitTargetOf(await request.formData(), params.name);
    if (!target.ok) {
      return target.failure;
    }
    const { sandbox } = target;
    const result = await attempt(() =>
      getPanelContext().sandboxGit.refresh(sandbox)
    );
    return result.ok ? { git: "Refreshed." } : result.failure;
  },

  remove: async ({ params, request }) => {
    const form = await request.formData();
    const target = targetOf(form, params.name);
    const hashes = hashesOf(form);
    const confirmation = form.get("confirmation");
    if (
      target === undefined ||
      hashes === undefined ||
      typeof confirmation !== "string"
    ) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().lifecycle.remove(target, confirmation.trim(), hashes)
    );
    if (!result.ok) {
      return result.failure;
    }
    redirect(303, "/");
  },

  start: async ({ params, request }) => {
    const form = await request.formData();
    const target = targetOf(form, params.name);
    const hashes = hashesOf(form);
    if (target === undefined || hashes === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().lifecycle.start(target, hashes)
    );
    return result.ok ? { started: true } : result.failure;
  },

  stop: async ({ params, request }) => {
    const target = targetOf(await request.formData(), params.name);
    if (target === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().lifecycle.stop(target)
    );
    return result.ok ? { stopped: true } : result.failure;
  },
};
