import { fail } from "@sveltejs/kit";

import { attempt, field, INCOMPLETE } from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";

import type { Actions } from "./$types";

// The queue itself comes with the layout, which every page has: the dialog
// over any page posts here.

const DECISIONS = ["allow", "always", "deny"] as const;

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

  dismiss: async ({ request }) => {
    const form = await request.formData();
    const id = field(form, "id");
    if (id === undefined) {
      return fail(400, INCOMPLETE);
    }
    if (!getPanelContext().mcp.approvals.dismiss(id)) {
      return fail(409, {
        message:
          "That request can't be dismissed: a call waits for it again, it was decided already, or the Panel restarted.",
      });
    }
    return { dismissed: id };
  },
};
