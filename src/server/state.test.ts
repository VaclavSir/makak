import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSandboxStore,
  isStateError,
  MAX_NOTES_LENGTH,
  StateError,
} from "./state.ts";

describe(createSandboxStore, () => {
  let dir: string;
  const stateDir = () => path.join(dir, "state");
  const stateFile = () => path.join(stateDir(), "sandboxes.json");

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-state-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("starts empty without creating anything", async () => {
    const store = createSandboxStore(stateDir());
    await expect(store.get("a")).resolves.toStrictEqual({ notes: "" });
    await expect(stat(stateDir())).rejects.toThrow(/ENOENT/u);
  });

  it("persists notes per sandbox id, readable only by the user", async () => {
    await createSandboxStore(stateDir()).setNotes("a", "for the shop\nfix");

    const reopened = createSandboxStore(stateDir());
    await expect(reopened.get("a")).resolves.toStrictEqual({
      notes: "for the shop\nfix",
    });
    await expect(reopened.get("b")).resolves.toStrictEqual({ notes: "" });
    const { mode } = await stat(stateFile());
    expect(mode.toString(8).slice(-3)).toBe("600");
  });

  it("applies concurrent writes in order, losing none", async () => {
    const store = createSandboxStore(stateDir());
    await Promise.all([
      store.setNotes("a", "1"),
      store.setNotes("b", "2"),
      store.setNotes("a", "3"),
    ]);

    const saved = JSON.parse(await readFile(stateFile(), "utf-8")) as unknown;
    expect(saved).toStrictEqual({
      sandboxes: { a: { notes: "3" }, b: { notes: "2" } },
    });
  });

  it("refuses notes over the limit", async () => {
    const store = createSandboxStore(stateDir());
    await expect(
      store.setNotes("a", "x".repeat(MAX_NOTES_LENGTH + 1))
    ).rejects.toThrow(StateError);
  });

  it("keeps changes made to the file while the Panel runs", async () => {
    const store = createSandboxStore(stateDir());
    await store.setNotes("a", "mine");
    await writeFile(
      stateFile(),
      '{"sandboxes": {"a": {"notes": "edited"}, "b": {"notes": "added"}}}'
    );

    await store.setNotes("c", "new");
    await expect(store.get("a")).resolves.toStrictEqual({ notes: "edited" });
    await expect(store.get("b")).resolves.toStrictEqual({ notes: "added" });

    await writeFile(stateFile(), "{ damaged");
    await expect(store.setNotes("a", "x")).rejects.toThrow(/damaged/u);
    await expect(readFile(stateFile(), "utf-8")).resolves.toBe("{ damaged");
  });

  it("reports a damaged file and leaves it alone", async () => {
    const store = createSandboxStore(dir);
    const file = path.join(dir, "sandboxes.json");
    await writeFile(file, "{ not json");

    await expect(store.get("a")).rejects.toThrow(/damaged/u);
    await expect(store.setNotes("a", "x")).rejects.toThrow(/damaged/u);
    await expect(readFile(file, "utf-8")).resolves.toBe("{ not json");

    // Fixed by hand: picked up without a restart.
    await writeFile(file, '{"sandboxes": {"a": {"notes": "back"}}}');
    await expect(store.get("a")).resolves.toStrictEqual({ notes: "back" });
  });

  describe("env records", () => {
    const env = {
      args: { project: "/p", sandbox: "feature-a" },
      createdAt: "2026-10-19T08:00:00.000Z",
      files: ["/envs/00-base.sbxenv.yaml"],
      name: "feature-a",
    };

    it("records how a sandbox was created, keeping its notes", async () => {
      const store = createSandboxStore(stateDir());
      await store.setNotes("a", "notes");
      await store.setEnv("a", env);

      await expect(
        createSandboxStore(stateDir()).get("a")
      ).resolves.toStrictEqual({ env, notes: "notes" });
    });

    it("lists every record and forgets one", async () => {
      const store = createSandboxStore(stateDir());
      await store.setEnv("a", env);
      await store.setNotes("b", "other");
      await store.forget("a");

      await expect(store.list()).resolves.toStrictEqual({
        b: { notes: "other" },
      });
    });
  });
});

describe(isStateError, () => {
  it("recognizes a StateError from another copy of the module by name", () => {
    const foreign = Object.assign(new Error("x"), { name: "StateError" });
    expect([
      isStateError(new StateError("x")),
      isStateError(foreign),
      isStateError(new Error("x")),
    ]).toStrictEqual([true, true, false]);
  });
});
