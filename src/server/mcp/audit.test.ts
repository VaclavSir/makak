import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAudit } from "./audit.ts";
import type { AuditEntry } from "./audit.ts";

const entry = (tool: string, server = "gitlab"): AuditEntry => ({
  arguments: { iid: 7 },
  at: "2026-10-25T10:00:00.000Z",
  ms: 3,
  outcome: "allowed",
  server,
  tool,
});

describe(createAudit, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-audit-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("is empty before the first call", async () => {
    await expect(createAudit(dir).recent(10)).resolves.toStrictEqual([]);
  });

  it("lists the latest entries first, skipping damaged ones", async () => {
    const audit = createAudit(dir);
    await audit.record(entry("a"));
    await audit.record(entry("b"));
    await appendFile(path.join(dir, "mcp-audit.jsonl"), '{"edited by\n');
    await audit.record(entry("c"));

    const recent = await audit.recent(2);
    expect(recent.map(({ tool }) => tool)).toStrictEqual(["c", "b"]);
    expect(recent[0]).toStrictEqual({ ...entry("c"), earlier: false });
    const all = await audit.recent(10);
    expect(all.map(({ tool }) => tool)).toStrictEqual(["c", "b", "a"]);
  });

  it("lists one server's entries, up to the limit", async () => {
    const audit = createAudit(dir);
    await audit.record(entry("a", "github"));
    await audit.record(entry("b"));
    await audit.record(entry("c", "github"));
    await audit.record(entry("d"));

    const recent = await audit.recent(10, "github");
    expect(recent.map(({ tool }) => tool)).toStrictEqual(["c", "a"]);
    await expect(audit.recent(1, "github")).resolves.toHaveLength(1);
  });

  it("adds each call's response, written after it", async () => {
    const audit = createAudit(dir);
    await audit.record({ ...entry("a"), id: "1" });
    await audit.record({ ...entry("b"), id: "2" });
    await audit.respond({
      at: "2026-10-25T10:00:01.000Z",
      by: "server",
      call: "1",
      error: false,
      text: "done",
      truncated: false,
    });

    const [b, a] = await audit.recent(10);
    expect(a?.response).toStrictEqual({
      at: "2026-10-25T10:00:01.000Z",
      by: "server",
      error: false,
      text: "done",
      truncated: false,
    });
    expect(b?.response).toBeUndefined();
    await expect(audit.recent(1)).resolves.toMatchObject([{ tool: "b" }]);
  });

  it("reads from the end in pieces, whatever falls across them", async () => {
    // Pieces of a few bytes, so lines and characters fall across them.
    const audit = createAudit(dir, { chunkBytes: 5 });
    await audit.record({ ...entry("a"), id: "1" });
    await audit.respond({
      at: "2026-10-25T10:00:01.000Z",
      by: "server",
      call: "1",
      error: false,
      text: "Příliš žluťoučký kůň 🐎",
      truncated: false,
    });
    await appendFile(path.join(dir, "mcp-audit.jsonl"), '{"edited by\n');
    await audit.record(entry("b"));

    const recent = await audit.recent(10);
    expect(recent.map(({ tool }) => tool)).toStrictEqual(["b", "a"]);
    expect(recent[1]?.response?.text).toBe("Příliš žluťoučký kůň 🐎");
    await expect(audit.recent(1)).resolves.toMatchObject([{ tool: "b" }]);
  });
});
