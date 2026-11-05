import { fail, redirect } from "@sveltejs/kit";

import { attempt, field, INCOMPLETE } from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";

import type { Actions, PageServerLoad } from "./$types";

// Where an MCP server's sign-in sends the browser back. Arriving is a GET,
// which must change nothing, so the page only shows what came back; posting
// it, from the Panel's own page, ends the sign-in.

export const load: PageServerLoad = ({ url }) => {
  const state = url.searchParams.get("state") ?? "";
  return {
    code: url.searchParams.get("code") ?? undefined,
    error:
      url.searchParams.get("error_description") ??
      url.searchParams.get("error") ??
      undefined,
    server: getPanelContext().mcp.oauth.pendingServer(state),
    state,
  };
};

export const actions: Actions = {
  finish: async ({ request }) => {
    const form = await request.formData();
    const code = field(form, "code");
    const state = field(form, "state");
    if (code === undefined || state === undefined) {
      return fail(400, INCOMPLETE);
    }
    const { health, oauth } = getPanelContext().mcp;
    const result = await attempt(() => oauth.finish(state, code));
    if (!result.ok) {
      return result.failure;
    }
    // So the page shows what the sign-in made reachable, its tools.
    await health.check(result.value);
    redirect(303, "/approvals");
  },
};
