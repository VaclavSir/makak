import { fail } from "@sveltejs/kit";

import { getPanelContext } from "#server/context.ts";
import { isStateError } from "#server/state.ts";
import type { Sandbox } from "#server/tools/index.ts";

import type { Actions, PageServerLoad } from "./$types";

const describe = async (version: () => Promise<string>) => {
  try {
    return await version();
  } catch (error) {
    return `unavailable: ${(error as Error).message}`;
  }
};

/**
 * Sandboxes the Panel created that no longer exist, newest first, to create
 * again. Undefined when sbx can't say which still exist, and the error when
 * the state file can't be read.
 */
const removedSandboxes = async () => {
  const { sandboxes, store } = getPanelContext();
  let listed: Sandbox[];
  try {
    listed = await sandboxes.list();
  } catch {
    // The layout reports it.
    return;
  }
  const ids = new Set(listed.map(({ id }) => id));
  let records: Awaited<ReturnType<typeof store.list>>;
  try {
    records = await store.list();
  } catch (error) {
    // The home page must still render; the error is shown in the list's place.
    if (isStateError(error)) {
      return error;
    }
    throw error;
  }
  return Object.entries(records)
    .flatMap(([id, { env, notes }]) =>
      env === undefined || ids.has(id)
        ? []
        : [{ createdAt: env.createdAt, id, name: env.name, notes }]
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
};

export const load: PageServerLoad = async () => {
  const { tools } = getPanelContext();
  const [git, sbx, removed] = await Promise.all([
    describe(tools.git.version),
    describe(tools.sbx.version),
    removedSandboxes(),
  ]);
  return removed instanceof Error
    ? { git, removed: undefined, sbx, stateError: removed.message }
    : { git, removed, sbx, stateError: undefined };
};

export const actions: Actions = {
  forget: async ({ request }) => {
    const form = await request.formData();
    const id = form.get("id");
    if (typeof id !== "string") {
      return fail(400, { message: "The form is incomplete." });
    }
    const removed = await removedSandboxes();
    if (removed instanceof Error) {
      return fail(500, { message: removed.message });
    }
    if (removed?.some((sandbox) => sandbox.id === id) !== true) {
      return fail(409, {
        message: "Only the records of removed sandboxes can be forgotten.",
      });
    }
    try {
      await getPanelContext().store.forget(id);
    } catch (error) {
      if (isStateError(error)) {
        return fail(500, { message: error.message });
      }
      throw error;
    }
    return { forgotten: true };
  },
};
