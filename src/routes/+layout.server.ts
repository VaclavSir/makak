import { SANDBOXES } from "#lib/dependencies.ts";
import { getPanelContext } from "#server/context.ts";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ depends }) => {
  depends(SANDBOXES);
  const { mcp, sandboxes } = getPanelContext();
  const pendingApprovals = mcp.approvals.pending().length;
  try {
    return {
      pendingApprovals,
      sandboxes: await sandboxes.list(),
      sbxError: undefined,
    };
  } catch (error) {
    // The Panel stays usable without sbx; the sidebar says what's wrong.
    return {
      pendingApprovals,
      sandboxes: undefined,
      sbxError: (error as Error).message,
    };
  }
};
