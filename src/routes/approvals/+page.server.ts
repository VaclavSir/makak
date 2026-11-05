import { fail, redirect } from "@sveltejs/kit";

import { MCP } from "#lib/dependencies.ts";
import { toolRows } from "#lib/mcp.ts";
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

/** The wrapped server's URL, without any credentials written into it. */
const shownUrl = (url: string) => {
  const shown = new URL(url);
  shown.username = "";
  shown.password = "";
  return shown.href;
};

export const load: PageServerLoad = async ({ depends }) => {
  depends(MCP);
  const { config, mcp } = getPanelContext();
  const { approvals, audit, health, oauth, registrations, servers, store } =
    mcp;
  // Never the servers' headers: they hold the credentials.
  const described = await orUserError(
    async () =>
      await Promise.all(
        servers.map(async (server) => {
          const { check, lastError } = health.status(server.name);
          const always = await store.allowed(server.name);
          return {
            // Without its tools, which are listed apart.
            check: check && {
              at: check.at,
              reason: check.ok ? undefined : check.reason,
              tools: check.ok ? check.tools.length : undefined,
            },
            holdSeconds: server.holdMs / 1000,
            lastError,
            name: server.name,
            signIn:
              server.oauth === undefined
                ? undefined
                : await oauth.status(server.name),
            tools: toolRows(check?.ok ? check.tools : [], server.allow, always),
            url: shownUrl(server.url),
          };
        })
      )
  );
  const recent = await orUserError(() => audit.recent(AUDIT_LIMIT));
  const registered = await orUserError(() => registrations.status());
  return {
    audit: recent.ok ? recent.value : [],
    error: [described, recent, registered]
      .flatMap((result) => (result.ok ? [] : [result.message]))
      .join(" "),
    origin: panelOrigin(config.panel.hostname, config.panel.port),
    pending: approvals.pending(),
    servers: (described.ok ? described.value : []).map((server) => ({
      ...server,
      // Undefined when sbx couldn't say.
      registration: registered.ok
        ? registered.value.get(server.name)
        : undefined,
    })),
  };
};

export const actions: Actions = {
  allow: async ({ request }) => {
    const form = await request.formData();
    const server = field(form, "server");
    const tool = field(form, "tool");
    if (server === undefined || tool === undefined) {
      return fail(400, INCOMPLETE);
    }
    const { servers, store } = getPanelContext().mcp;
    if (!servers.some(({ name }) => name === server)) {
      return fail(404, { message: `There is no MCP server named ${server}.` });
    }
    const result = await attempt(() => store.allow(server, tool));
    return result.ok ? { allowed: tool } : result.failure;
  },

  check: async ({ request }) => {
    const server = field(await request.formData(), "server");
    const { health, servers } = getPanelContext().mcp;
    if (server === undefined || !servers.some(({ name }) => name === server)) {
      return fail(400, INCOMPLETE);
    }
    await health.check(server);
    return { checked: server };
  },

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

  register: async ({ request }) => {
    const server = field(await request.formData(), "server");
    if (server === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().mcp.registrations.register(server)
    );
    return result.ok ? { registered: server } : result.failure;
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

  unregister: async ({ request }) => {
    const server = field(await request.formData(), "server");
    if (server === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().mcp.registrations.unregister(server)
    );
    return result.ok
      ? { left: result.value, unregistered: server }
      : result.failure;
  },
};
