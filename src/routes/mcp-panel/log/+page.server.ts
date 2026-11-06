import { MCP } from "#lib/dependencies.ts";
import { orUserError } from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";

import type { PageServerLoad } from "./$types";

const LIMIT = 200;

export const load: PageServerLoad = async ({ depends, url }) => {
  depends(MCP);
  const { audit, servers } = getPanelContext().mcp;
  const names = servers.map(({ name }) => name);
  // Only a configured server's: anything else lists everything.
  const asked = url.searchParams.get("server");
  const server = names.find((name) => name === asked);
  const recent = await orUserError(() => audit.recent(LIMIT, server));
  return {
    entries: recent.ok ? recent.value : [],
    error: recent.ok ? "" : recent.message,
    limit: LIMIT,
    server,
    servers: names,
  };
};
