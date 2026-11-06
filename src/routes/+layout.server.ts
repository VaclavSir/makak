import { MCP, SANDBOXES } from "#lib/dependencies.ts";
import { getPanelContext } from "#server/context.ts";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ depends }) => {
  depends(SANDBOXES);
  // The approval queue, which the sidebar counts and the dialog shows.
  depends(MCP);
  const { mcp, sandboxes } = getPanelContext();
  const pending = mcp.approvals.pending();
  try {
    return {
      pending,
      sandboxes: await sandboxes.list(),
      sbxError: undefined,
    };
  } catch (error) {
    // The Panel stays usable without sbx; the sidebar says what's wrong.
    return {
      pending,
      sandboxes: undefined,
      sbxError: (error as Error).message,
    };
  }
};
