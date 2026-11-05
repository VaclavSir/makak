import { describe, expect, it } from "vitest";

import { CommandError } from "../tools/exec.ts";
import { createMcpLoads } from "./loads.ts";
import type { RegistrationStatus } from "./registrations.ts";

const statuses = new Map<string, RegistrationStatus>([
  ["linear", { detail: undefined, state: "ready" }],
  ["gitlab", { detail: undefined, state: "missing" }],
  ["jira", { detail: "Register it again.", state: "stale" }],
]);

const SERVERS = [{ name: "linear" }, { name: "gitlab" }, { name: "jira" }];

/** Loads into a stand-in sbx, which `fail` makes refuse. */
const loadsWith = ({
  errors = [],
  fail = false,
}: {
  errors?: { at: number; message: string }[];
  fail?: boolean;
} = {}) => {
  const calls: string[][] = [];
  let clock = 1000;
  const loads = createMcpLoads({
    health: {
      errorSince: (_server, since) => {
        const error = errors.findLast(({ at }) => at >= since);
        return error && { at: String(error.at), message: error.message };
      },
    },
    now: () => clock,
    registrations: { status: () => Promise.resolve(statuses) },
    sbx: {
      mcpLoad: (server, sandbox) => {
        calls.push(["load", server, sandbox]);
        clock += 1;
        errors.push({ at: clock, message: "HTTP 403: not enabled" });
        return fail
          ? Promise.reject(new CommandError("sbx: Forbidden"))
          : Promise.resolve();
      },
      mcpUnload: (server, sandbox) => {
        calls.push(["unload", server, sandbox]);
        return Promise.resolve();
      },
    },
    servers: SERVERS,
  });
  return { calls, loads };
};

describe(createMcpLoads, () => {
  it("loads and unloads with sbx", async () => {
    const { calls, loads } = loadsWith();
    await loads.load("linear", "feature-a");
    await loads.unload("linear", "feature-a");

    expect(calls).toStrictEqual([
      ["load", "linear", "feature-a"],
      ["unload", "linear", "feature-a"],
    ]);
  });

  it("explains a failed load with what the server answered meanwhile", async () => {
    await expect(
      loadsWith({ fail: true }).loads.load("linear", "feature-a")
    ).rejects.toThrow(
      "sbx couldn't load linear into feature-a: connecting to it, the server answered HTTP 403: not enabled"
    );
  });

  it("passes on sbx's failure when the server said nothing since", async () => {
    const quiet = createMcpLoads({
      now: () => 0,
      registrations: { status: () => Promise.resolve(statuses) },
      sbx: {
        mcpLoad: () => Promise.reject(new CommandError("sbx: Forbidden")),
        mcpUnload: () => Promise.resolve(),
      },
      servers: SERVERS,
    });
    await expect(quiet.load("linear", "feature-a")).rejects.toThrow(
      "sbx: Forbidden"
    );
  });

  it("says why servers can't be loaded", async () => {
    const { loads } = loadsWith();

    await expect(loads.problems(["linear"])).resolves.toStrictEqual([]);
    await expect(loads.problems([])).resolves.toStrictEqual([]);
    await expect(loads.problems(["gitlab", "jira"])).resolves.toStrictEqual([
      "gitlab isn't registered with sbx. Register it on the MCP approvals page first.",
      "jira is registered with sbx, but can't be used: Register it again.",
    ]);
    await expect(loads.problems(["linear", "nope"])).resolves.toStrictEqual([
      "There is no MCP server named nope in the config.",
    ]);
  });
});
