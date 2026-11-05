import { describe, expect, it } from "vitest";

import { setPanelContext } from "#server/context.ts";
import type { PanelContext } from "#server/context.ts";
import type { ServerHealth } from "#server/mcp/health.ts";
import type { RegistrationStatus } from "#server/mcp/registrations.ts";
import { CommandError } from "#server/tools/exec.ts";

import { mcpChoices } from "./mcp.ts";

const NAMES = ["ready", "failing", "missing", "stale"];

/** A Panel context with just what the choices read. */
const withContext = (
  statuses: () => Promise<Map<string, RegistrationStatus>>
) => {
  const health: Record<string, ServerHealth> = {
    failing: {
      check: { at: "t", ok: false, reason: "HTTP 403: not enabled" },
      lastError: undefined,
    },
  };
  setPanelContext({
    mcp: {
      health: {
        status: (name: string) =>
          health[name] ?? { check: undefined, lastError: undefined },
      },
      registrations: { status: statuses },
      servers: NAMES.map((name) => ({ name })),
    },
  } as unknown as PanelContext);
};

describe(mcpChoices, () => {
  it("says what stands in the way of loading each server", async () => {
    withContext(() =>
      Promise.resolve(
        new Map<string, RegistrationStatus>([
          ["ready", { detail: undefined, state: "ready" }],
          ["failing", { detail: undefined, state: "ready" }],
          ["missing", { detail: undefined, state: "missing" }],
          ["stale", { detail: "Register it again.", state: "stale" }],
        ])
      )
    );

    await expect(mcpChoices()).resolves.toStrictEqual({
      choices: [
        { name: "ready", problem: undefined },
        { name: "failing", problem: "Failed its check: HTTP 403: not enabled" },
        { name: "missing", problem: "Not registered with sbx yet." },
        { name: "stale", problem: "Registered with sbx, but not usable." },
      ],
      error: undefined,
    });
  });

  it("offers none when sbx can't say what's registered", async () => {
    withContext(() => Promise.reject(new CommandError("sbx is down")));

    const { choices, error } = await mcpChoices();
    expect(error).toBe("sbx is down");
    expect(choices.every(({ problem }) => problem !== undefined)).toBeTruthy();
  });
});
