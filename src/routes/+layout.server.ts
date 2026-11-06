import { MCP, SANDBOXES } from "#lib/dependencies.ts";
import { getPanelContext } from "#server/context.ts";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ depends }) => {
  depends(SANDBOXES);
  // The approval queue, which the sidebar counts and the dialog shows.
  depends(MCP);
  const { mcp, sandboxRuns, sandboxes } = getPanelContext();
  const pending = mcp.approvals.pending();
  try {
    const listed = await sandboxes.list();
    return {
      // Streamed: asking every sandbox must not hold up the page.
      active: sandboxRuns.active(listed),
      pending,
      sandboxes: listed,
      sbxError: undefined,
    };
  } catch (error) {
    // The Panel stays usable without sbx; the sidebar says what's wrong.
    return {
      active: Promise.resolve({}),
      pending,
      sandboxes: undefined,
      sbxError: (error as Error).message,
    };
  }
};
