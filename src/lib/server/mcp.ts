import type { McpChoice } from "#lib/mcp.ts";
import { getPanelContext } from "#server/context.ts";

import { orUserError } from "./actions.ts";

// The MCP servers a sandbox can be given, for the create form and the
// sandbox page. Server-only: `$lib/server` is never bundled for the browser.

/**
 * Every configured server, with what stands in the way of loading it: its
 * registration with sbx, then its last check. `error` says why sbx couldn't
 * be asked, and then no server can be chosen.
 */
export const mcpChoices = async (): Promise<{
  choices: McpChoice[];
  error: string | undefined;
}> => {
  const { health, registrations, servers } = getPanelContext().mcp;
  const statuses = await orUserError(() => registrations.status());
  const choices = servers.map(({ name }) => {
    if (!statuses.ok) {
      return { name, problem: "sbx can't say whether it's registered." };
    }
    const registration = statuses.value.get(name);
    if (registration?.state === "missing") {
      return { name, problem: "Not registered with sbx yet." };
    }
    if (registration !== undefined && registration.state !== "ready") {
      return { name, problem: "Registered with sbx, but not usable." };
    }
    const { check } = health.status(name);
    if (check !== undefined && !check.ok) {
      return { name, problem: `Failed its check: ${check.reason}` };
    }
    return { name, problem: undefined };
  });
  return { choices, error: statuses.ok ? undefined : statuses.message };
};
