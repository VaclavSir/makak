import { fail, redirect } from "@sveltejs/kit";

import { MCP } from "#lib/dependencies.ts";
import {
  attempt,
  field,
  INCOMPLETE,
  orUserError,
} from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";
import { panelOrigin } from "#server/panel.ts";

import type { Actions, PageServerLoad } from "./$types";

const AUDIT_LIMIT = 100;

const DECISIONS = ["allow", "always", "deny"] as const;

export const load: PageServerLoad = async ({ depends }) => {
  depends(MCP);
  const { config, mcp } = getPanelContext();
  const { approvals, audit, oauth, servers, store } = mcp;
  // Never the servers' headers: they hold the credentials.
  const described = await orUserError(
    async () =>
      await Promise.all(
        servers.map(async (server) => ({
          allow: server.allow,
          always: await store.allowed(server.name),
          holdSeconds: server.holdMs / 1000,
          name: server.name,
          signIn:
            server.oauth === undefined
              ? undefined
              : await oauth.status(server.name),
        }))
      )
  );
  const recent = await orUserError(() => audit.recent(AUDIT_LIMIT));
  return {
    audit: recent.ok ? recent.value : [],
    error: [described, recent]
      .flatMap((result) => (result.ok ? [] : [result.message]))
      .join(" "),
    origin: panelOrigin(config.panel.hostname, config.panel.port),
    pending: approvals.pending(),
    servers: described.ok ? described.value : [],
  };
};

export const actions: Actions = {
  decide: async ({ request }) => {
    const form = await request.formData();
    const id = field(form, "id");
    const decision = DECISIONS.find((each) => each === field(form, "decision"));
    if (id === undefined || decision === undefined) {
      return fail(400, INCOMPLETE);
    }
    const { approvals, store } = getPanelContext().mcp;
    // The server and tool come from the queue, never from the form.
    const pending = approvals.pending().find((each) => each.id === id);
    if (pending === undefined) {
      return fail(404, {
        message:
          "That request is no longer waiting: it was decided already, or the Panel restarted.",
      });
    }
    if (decision === "always") {
      const saved = await attempt(() =>
        store.allow(pending.server, pending.tool)
      );
      if (!saved.ok) {
        return saved.failure;
      }
    }
    approvals.decide(id, decision === "deny" ? "denied" : "approved");
    return { decided: id };
  },

  disallow: async ({ request }) => {
    const form = await request.formData();
    const server = field(form, "server");
    const tool = field(form, "tool");
    if (server === undefined || tool === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().mcp.store.disallow(server, tool)
    );
    return result.ok ? { disallowed: tool } : result.failure;
  },

  /** Sends the browser to the server's sign-in, which comes back to /oauth/callback. */
  signIn: async ({ request }) => {
    const server = field(await request.formData(), "server");
    if (server === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().mcp.oauth.begin(server)
    );
    if (!result.ok) {
      return result.failure;
    }
    // To the server's own page, which the Panel found in its metadata.
    redirect(303, result.value, { external: true });
  },

  signOut: async ({ request }) => {
    const server = field(await request.formData(), "server");
    if (server === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().mcp.oauth.signOut(server)
    );
    return result.ok ? { signedOut: server } : result.failure;
  },
};
