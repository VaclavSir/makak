import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpStore } from "./store.ts";
import type { McpStore } from "./store.ts";

const A = { id: "id-a", name: "feature-a" };
const B = { id: "id-b", name: "feature-b" };
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

  it("identifies a sandbox by its token", async () => {
    const a = await store.register("gitlab", A, NOW);
    const b = await store.register("gitlab", B, NOW);

    await expect(store.identify(a)).resolves.toStrictEqual({
      createdAt: NOW.toISOString(),
      sandbox: "feature-a",
      sandboxId: "id-a",
      server: "gitlab",
    });
    await expect(store.identify(b)).resolves.toMatchObject({
      sandboxId: "id-b",
    });
    await expect(store.identify("forged")).resolves.toBeUndefined();
    await expect(store.identify("__proto__")).resolves.toBeUndefined();
  });

  it("keeps one token per server and sandbox", async () => {
    const old = await store.register("gitlab", A);
    const linear = await store.register("linear", A);
    const fresh = await store.register("gitlab", A);

    await expect(store.identify(old)).resolves.toBeUndefined();
    await expect(store.identify(fresh)).resolves.toMatchObject({
      server: "gitlab",
    });
    await expect(store.identify(linear)).resolves.toMatchObject({
      server: "linear",
    });

    await store.unregister("gitlab", "id-a");
    await expect(store.identify(fresh)).resolves.toBeUndefined();
    await expect(store.registrations()).resolves.toHaveLength(1);
  });

  it("never writes a token to the file", async () => {
    const token = await store.register("gitlab", A);
    const text = await readFile(path.join(dir, "mcp.json"), "utf-8");
    expect(text).not.toContain(token);
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
