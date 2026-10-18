import { error as httpError, fail } from "@sveltejs/kit";

import { SANDBOX_PAGE } from "#lib/dependencies.ts";
import { getPanelContext } from "#server/context.ts";
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
  const { config, store } = getPanelContext();
  const sandbox = await findSandbox(params.name);
  let notes: string;
  try {
    ({ notes } = await store.get(sandbox.id));
  } catch (error) {
    if (isStateError(error)) {
      httpError(500, error.message);
    }
    throw error;
  }
  const { listeners, suffixes } = config.proxy;
  return {
    maxNotesLength: MAX_NOTES_LENGTH,
    notes,
    proxy: { listeners, suffixes },
    sandbox,
    sshSuffix: config.ssh.hostSuffix,
  };
};

export const actions: Actions = {
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
};
