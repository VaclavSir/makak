import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpStore } from "./store.ts";
import type { McpStore } from "./store.ts";

const NOW = new Date("2026-10-25T10:00:00Z");

describe(createMcpStore, () => {
  let dir: string;
  let store: McpStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-mcp-"));
    store = createMcpStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("identifies a server by its token", async () => {
    const gitlab = await store.issue("gitlab", NOW);
    const linear = await store.issue("linear", NOW);

    await expect(store.identify(gitlab)).resolves.toBe("gitlab");
    await expect(store.identify(linear)).resolves.toBe("linear");
    await expect(store.identify("forged")).resolves.toBeUndefined();
    await expect(store.identify("__proto__")).resolves.toBeUndefined();
  });

  it("keeps one token per server, until revoked", async () => {
    const old = await store.issue("gitlab");
    const linear = await store.issue("linear");
    const fresh = await store.issue("gitlab");

    await expect(store.identify(old)).resolves.toBeUndefined();
    await expect(store.identify(fresh)).resolves.toBe("gitlab");

    await store.revoke("gitlab");
    await expect(store.identify(fresh)).resolves.toBeUndefined();
    await expect(store.identify(linear)).resolves.toBe("linear");
  });

  it("never writes a token to the file", async () => {
    const token = await store.issue("gitlab", NOW);
    const text = await readFile(path.join(dir, "mcp.json"), "utf-8");
    expect(text).not.toContain(token);
    const { tokens } = JSON.parse(text) as { tokens: object };
    expect(Object.values(tokens)).toStrictEqual([
      { createdAt: NOW.toISOString(), server: "gitlab" },
    ]);
  });

  it("drops the per-sandbox tokens of earlier versions", async () => {
    await writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        allowed: { gitlab: ["get_issue"] },
        registrations: { abc: { sandbox: "a", server: "gitlab" } },
      })
    );
    await store.issue("gitlab");

    const text = await readFile(path.join(dir, "mcp.json"), "utf-8");
    expect(Object.keys(JSON.parse(text) as object).toSorted()).toStrictEqual([
      "allowed",
      "tokens",
    ]);
    await expect(store.allowed("gitlab")).resolves.toStrictEqual(["get_issue"]);
  });

  it("remembers the tools always allowed, per server", async () => {
    await store.allow("gitlab", "list_issues");
    await store.allow("gitlab", "get_issue");
    await store.allow("gitlab", "get_issue");
    await store.allow("linear", "get_issue");
    await store.disallow("gitlab", "list_issues");

    await expect(store.allowed("gitlab")).resolves.toStrictEqual(["get_issue"]);
    await expect(store.allowed("linear")).resolves.toStrictEqual(["get_issue"]);
    await expect(store.allowed("jira")).resolves.toStrictEqual([]);
  });
});
