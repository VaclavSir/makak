import { error as httpError } from "@sveltejs/kit";

import { SANDBOX_PAGE } from "#lib/dependencies.ts";
import { orUserError } from "#lib/server/actions.ts";
import { findSandbox } from "#lib/server/sandbox.ts";
import { getPanelContext } from "#server/context.ts";
import type { Inspection } from "#server/lifecycle.ts";
import { isStateError, MAX_NOTES_LENGTH } from "#server/state.ts";
import type { Sandbox } from "#server/tools/index.ts";

import type { LayoutServerLoad } from "./$types";

// Shared by the sandbox's overview and its run tabs. The forms they submit
// all go to the overview's actions.

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
export const load: LayoutServerLoad = async ({ depends, params }) => {
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
