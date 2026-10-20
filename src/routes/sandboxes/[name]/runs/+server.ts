import { json } from "@sveltejs/kit";

import { orUserError } from "#lib/server/actions.ts";
import { findSandbox } from "#lib/server/sandbox.ts";
import { getPanelContext } from "#server/context.ts";

import type { RequestHandler } from "./$types";

/** The sandbox's runs, newest first, for the pages that poll them. */
export const GET: RequestHandler = async ({ params }) => {
  const sandbox = await findSandbox(params.name);
  if (sandbox.status !== "running") {
    return json({ error: undefined, runs: undefined });
  }
  const result = await orUserError(() =>
    getPanelContext().sandboxRuns.list(sandbox)
  );
  return json(
    result.ok
      ? { error: undefined, runs: result.value }
      : { error: result.message, runs: undefined }
  );
};
