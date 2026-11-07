import { getPanelContext } from "#server/context.ts";
import { approvalEvents } from "#server/mcp/approval-events.ts";

import type { RequestHandler } from "./$types";

/**
 * The tool calls waiting for the user, as server-sent events: the whole
 * list on connect and whenever it changes. Open until the browser goes away.
 */
export const GET: RequestHandler = ({ request }) =>
  new Response(
    approvalEvents(getPanelContext().mcp.approvals, {
      signal: request.signal,
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
        "x-content-type-options": "nosniff",
      },
    }
  );
