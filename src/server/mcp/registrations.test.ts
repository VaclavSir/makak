import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandError } from "../tools/exec.ts";
import { createFakeSbx } from "../tools/index.ts";
import type { Sbx } from "../tools/index.ts";
import { createMcpRegistrations, tokenSecret } from "./registrations.ts";
import { createMcpStore } from "./store.ts";
import type { McpStore } from "./store.ts";

const ORIGIN = "https://makakctl.test:7443";

/** The fake sbx, recording each change; `fail` names one to refuse. */
const recordingSbx = () => {
  const fake = createFakeSbx();
  const calls: unknown[][] = [];
  const state: { fail: string | undefined } = { fail: undefined };
  const wrap =
    <A extends unknown[]>(what: string, run: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      calls.push([what, ...args]);
      if (state.fail === what) {
        throw new CommandError(`${what} failed`);
      }
      await run(...args);
    };
  const sbx: Pick<
    Sbx,
    "mcpAdd" | "mcpList" | "mcpRm" | "secretRm" | "secretSet"
  > = {
    mcpAdd: wrap("mcpAdd", fake.mcpAdd),
    mcpList: () => fake.mcpList(),
    mcpRm: wrap("mcpRm", fake.mcpRm),
    secretRm: wrap("secretRm", fake.secretRm),
    secretSet: wrap("secretSet", fake.secretSet),
  };
  return { calls, sbx, state };
};

describe(createMcpRegistrations, () => {
  let dir: string;
  let store: McpStore;
  let recorded: ReturnType<typeof recordingSbx>;
  let signedIn: boolean;

  const registrations = () =>
    createMcpRegistrations({
      oauth: { status: () => Promise.resolve({ signedIn }) },
      origin: ORIGIN,
      sbx: recorded.sbx,
      servers: [{ name: "linear" }, { name: "gitlab", oauth: { scopes: [] } }],
      store,
    });

  const stateOf = async (name: string) => {
    const statuses = await registrations().status();
    return statuses.get(name)?.state;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-registrations-"));
    store = createMcpStore(dir);
    recorded = recordingSbx();
    signedIn = true;
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("stores the token, then registers the endpoint with it", async () => {
    await registrations().register("linear");

    const [set, add] = recorded.calls;
    const token = set?.[2] as string;
    expect(set).toStrictEqual(["secretSet", "mcp:linear:token", token]);
    // The secret is the token the endpoint accepts.
    await expect(store.identify(token)).resolves.toBe("linear");
    expect(add).toStrictEqual([
      "mcpAdd",
      {
        // oxlint-disable-next-line no-template-curly-in-string -- sbx's placeholder
        headers: ["Authorization: Bearer ${token}"],
        name: "linear",
        url: `${ORIGIN}/mcp/linear`,
      },
    ]);
    await expect(stateOf("linear")).resolves.toBe("ready");
    await expect(stateOf("gitlab")).resolves.toBe("missing");
  });

  it("replaces an earlier registration, and its token", async () => {
    await registrations().register("linear");
    const old = recorded.calls[0]?.[2] as string;
    recorded.calls.length = 0;
    await registrations().register("linear");

    expect(recorded.calls.map(([what]) => what)).toStrictEqual([
      "mcpRm",
      "secretSet",
      "mcpAdd",
    ]);
    await expect(store.identify(old)).resolves.toBeUndefined();
    await expect(stateOf("linear")).resolves.toBe("ready");
  });

  it("takes back the token and secret when sbx refuses the registration", async () => {
    recorded.state.fail = "mcpAdd";
    await expect(registrations().register("linear")).rejects.toThrow(
      "mcpAdd failed"
    );

    await expect(store.issued()).resolves.toStrictEqual([]);
    expect(recorded.calls.at(-1)).toStrictEqual([
      "secretRm",
      "mcp:linear:token",
    ]);
  });

  it("registers no server nobody signed in to, or that isn't configured", async () => {
    signedIn = false;
    await expect(registrations().register("gitlab")).rejects.toThrow(
      "Sign in to gitlab first: sbx connects to the server when it registers it."
    );
    await expect(registrations().register("jira")).rejects.toThrow(
      "There is no MCP server named jira in the config."
    );
    expect(recorded.calls).toStrictEqual([]);
  });

  it("tells a registration sbx can't use from one the Panel has no token for", async () => {
    await registrations().register("linear");
    await recorded.sbx.secretRm(tokenSecret("linear"));
    const statuses = await registrations().status();
    expect(statuses.get("linear")).toStrictEqual({
      detail:
        "sbx reports it as needs-secret (1 header secret not set). Registering it again sets its secret anew.",
      state: "unusable",
    });

    await registrations().register("linear");
    await store.revoke("linear");
    await expect(stateOf("linear")).resolves.toBe("stale");
  });

  it("removes the registration and its secret, and revokes the token", async () => {
    await registrations().register("linear");
    recorded.calls.length = 0;

    await expect(registrations().unregister("linear")).resolves.toStrictEqual(
      []
    );
    expect(recorded.calls).toStrictEqual([
      ["mcpRm", "linear"],
      ["secretRm", "mcp:linear:token"],
    ]);
    await expect(store.issued()).resolves.toStrictEqual([]);
    await expect(stateOf("linear")).resolves.toBe("missing");
  });

  it("returns the commands for what sbx refused to remove", async () => {
    await registrations().register("linear");
    recorded.state.fail = "mcpRm";

    await expect(registrations().unregister("linear")).resolves.toStrictEqual([
      "sbx mcp rm --force linear",
    ]);
    await expect(store.issued()).resolves.toStrictEqual([]);
  });

  it("leaves alone a secret sbx says is missing, or was never registered", async () => {
    await registrations().register("linear");
    await recorded.sbx.secretRm(tokenSecret("linear"));
    recorded.calls.length = 0;
    recorded.state.fail = "secretRm";

    await expect(registrations().unregister("linear")).resolves.toStrictEqual(
      []
    );
    await expect(registrations().unregister("gitlab")).resolves.toStrictEqual(
      []
    );
    expect(recorded.calls).toStrictEqual([
      ["mcpRm", "linear"],
      ["secretRm", "mcp:gitlab:token"],
    ]);
  });
});
