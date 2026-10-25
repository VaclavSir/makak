import { fail, redirect } from "@sveltejs/kit";

import {
  attempt,
  field,
  hashesSchema,
  INCOMPLETE,
  jsonField,
} from "#lib/server/actions.ts";
import { findSandbox, sandboxOf, targetOf } from "#lib/server/sandbox.ts";
import { getPanelContext } from "#server/context.ts";
import { isStateError, MAX_NOTES_LENGTH } from "#server/state.ts";

import type { Actions } from "./$types";

/** Hashes as the page saw the env files; none when it used no plan. */
const hashesOf = (form: FormData) =>
  jsonField(hashesSchema, form.get("hashes") ?? "[]");

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
