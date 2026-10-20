import { error as httpError, fail, redirect } from "@sveltejs/kit";

import { SANDBOX_PAGE } from "#lib/dependencies.ts";
import {
  attempt,
  hashesSchema,
  orUserError,
  INCOMPLETE,
  jsonField,
} from "#lib/server/actions.ts";
import { findSandbox, sandboxOf, targetOf } from "#lib/server/sandbox.ts";
import { getPanelContext } from "#server/context.ts";
import type { Inspection } from "#server/lifecycle.ts";
import { isStateError, MAX_NOTES_LENGTH } from "#server/state.ts";
import type { Sandbox } from "#server/tools/index.ts";

import type { Actions, PageServerLoad } from "./$types";

/**
 * What can be run in the sandbox, and its runs. Only a running sandbox can
 * be asked; `error` says why it couldn't.
 */
const runsOf = async (sandbox: Sandbox) => {
  const { sandboxRuns } = getPanelContext();
  const view = {
    commands: sandboxRuns.commands(sandbox),
    error: undefined as string | undefined,
    list: undefined as Awaited<ReturnType<typeof sandboxRuns.list>> | undefined,
    prompt: sandboxRuns.promptCommand(sandbox, "") !== undefined,
    scripts: undefined as Awaited<ReturnType<typeof sandboxRuns.scripts>>,
  };
  if (sandbox.status !== "running") {
    return view;
  }
  const result = await orUserError(() =>
    Promise.all([sandboxRuns.list(sandbox), sandboxRuns.scripts(sandbox)])
  );
  if (!result.ok) {
    return { ...view, error: result.message };
  }
  const [list, scripts] = result.value;
  return { ...view, list, scripts };
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
    // Streamed: asking the sandbox must not hold up the rest of the page.
    runs: runsOf(sandbox),
    sandbox,
    sshSuffix: config.ssh.hostSuffix,
  };
};

/** Hashes as the page saw the env files; none when it used no plan. */
const hashesOf = (form: FormData) =>
  jsonField(hashesSchema, form.get("hashes") ?? "[]");

/** A text field, or undefined when it is missing. */
const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

const runPage = (name: string, id: string) =>
  `/sandboxes/${encodeURIComponent(name)}/runs/${encodeURIComponent(id)}`;

/** Like `sandboxOf`, with the branch and SHA the page showed. */
const branchActionOf = async (form: FormData, name: string) => {
  const branch = form.get("branch");
  const sha = form.get("sha");
  if (typeof branch !== "string" || typeof sha !== "string") {
    return { failure: fail(400, INCOMPLETE), ok: false } as const;
  }
  const target = await sandboxOf(form, name);
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
    const target = await sandboxOf(await request.formData(), params.name);
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

  rerun: async ({ params, request }) => {
    const form = await request.formData();
    const target = await sandboxOf(form, params.name);
    const run = field(form, "run");
    if (!target.ok) {
      return target.failure;
    }
    if (run === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().sandboxRuns.rerun(target.sandbox, run)
    );
    if (!result.ok) {
      return result.failure;
    }
    redirect(303, runPage(params.name, result.value));
  },

  /** Starts a run and opens it: a command, a package.json script, or a prompt. */
  run: async ({ params, request }) => {
    const form = await request.formData();
    const target = await sandboxOf(form, params.name);
    if (!target.ok) {
      return target.failure;
    }
    const { sandbox } = target;
    const { sandboxRuns } = getPanelContext();
    const kind = field(form, "kind");
    const result = await attempt(async () => {
      if (kind === "script") {
        return await sandboxRuns.startScript(
          sandbox,
          field(form, "script") ?? ""
        );
      }
      if (kind === "prompt") {
        return await sandboxRuns.startPrompt(
          sandbox,
          field(form, "prompt") ?? ""
        );
      }
      return await sandboxRuns.start(
        sandbox,
        field(form, "command") ?? "",
        field(form, "cwd") ?? sandbox.workspaces[0] ?? ""
      );
    });
    if (!result.ok) {
      return result.failure;
    }
    redirect(303, runPage(params.name, result.value));
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

  stopRun: async ({ params, request }) => {
    const form = await request.formData();
    const target = await sandboxOf(form, params.name);
    const run = field(form, "run");
    if (!target.ok) {
      return target.failure;
    }
    if (run === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().sandboxRuns.stop(target.sandbox, run)
    );
    return result.ok ? { stopped: run } : result.failure;
  },
};
