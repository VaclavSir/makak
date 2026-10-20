import { error as httpError } from "@sveltejs/kit";

import { RUN_PAGE } from "#lib/dependencies.ts";
import { RUN_COLUMNS, RUN_ROWS } from "#lib/runs.ts";
import { orUserError } from "#lib/server/actions.ts";
import { findSandbox } from "#lib/server/sandbox.ts";
import { getPanelContext } from "#server/context.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ depends, params }) => {
  depends(RUN_PAGE);
  const sandbox = await findSandbox(params.name);
  const size = { columns: RUN_COLUMNS, rows: RUN_ROWS };
  if (sandbox.status !== "running") {
    return {
      problem: `${sandbox.name} isn't running. Its runs are kept in it, so start it to see this one.`,
      run: undefined,
      sandbox,
      size,
    };
  }
  const listed = await orUserError(() =>
    getPanelContext().sandboxRuns.list(sandbox)
  );
  if (!listed.ok) {
    return { problem: listed.message, run: undefined, sandbox, size };
  }
  const run = listed.value.find(({ id }) => id === params.run);
  if (run === undefined) {
    httpError(404, `${sandbox.name} has no run ${params.run}.`);
  }
  return { problem: undefined, run, sandbox, size };
};
