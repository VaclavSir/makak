import { describe, expect, it } from "vitest";

import { createSandboxRuns, shellQuote } from "./sandbox-runs.ts";
import type { Sandbox } from "./tools/index.ts";
import { createFakeRuns } from "./tools/runs.ts";

const sandbox: Sandbox = {
  agent: "claude",
  createdAt: undefined,
  id: "id-1",
  lastUsedAt: undefined,
  name: "s",
  ports: [],
  status: "running",
  workspaces: ["/p/shop", "/p/docs"],
};

const setup = () => {
  const runs = createFakeRuns();
  const sandboxRuns = createSandboxRuns({
    now: () => new Date("2026-10-20T21:30:05Z"),
    projects: [
      {
        commands: [{ command: "npm start", label: "Start" }],
        path: "/p/shop/",
      },
      { commands: [{ command: "make", label: "Make" }], path: "/p/other" },
    ],
    runs,
  });
  return { runs, sandboxRuns };
};

describe(shellQuote, () => {
  it.each([
    ["dev", "dev"],
    ["test:unit", "test:unit"],
    ["two words", "'two words'"],
    ["it's", String.raw`'it'\''s'`],
    ["$(rm -rf ~)", "'$(rm -rf ~)'"],
    ["", "''"],
  ])("quotes %j as %s", (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
  });
});

describe(createSandboxRuns, () => {
  it("offers the commands configured for the sandbox's projects", () => {
    const { sandboxRuns } = setup();
    expect(sandboxRuns.commands(sandbox)).toStrictEqual([
      { command: "npm start", cwd: "/p/shop/", label: "Start" },
    ]);
  });

  it("starts a command in a workspace, with a sortable id", async () => {
    const { runs, sandboxRuns } = setup();
    const id = await sandboxRuns.start(sandbox, "npm test", "/p/docs");
    expect(id).toMatch(/^20261020-213005-[0-9a-f]{6}$/u);
    await expect(runs.list("s")).resolves.toMatchObject([
      { command: "npm test", cwd: "/p/docs", id },
    ]);
  });

  it("refuses a directory outside the workspaces, or an empty command", async () => {
    const { sandboxRuns } = setup();
    await expect(sandboxRuns.start(sandbox, "ls", "/etc")).rejects.toThrow(
      /isn't one of s's workspaces/u
    );
    await expect(sandboxRuns.start(sandbox, "  ", "/p/shop")).rejects.toThrow(
      /Type a command/u
    );
  });

  it("refuses a stopped sandbox", async () => {
    const { sandboxRuns } = setup();
    const stopped = { ...sandbox, status: "stopped" };
    await expect(sandboxRuns.start(stopped, "ls", "/p/shop")).rejects.toThrow(
      /isn't running/u
    );
    await expect(sandboxRuns.scripts(stopped)).resolves.toBeUndefined();
  });

  it("runs package.json scripts with the project's package manager", async () => {
    const { runs, sandboxRuns } = setup();
    await expect(sandboxRuns.scripts(sandbox)).resolves.toStrictEqual({
      cwd: "/p/shop",
      manager: "pnpm",
      names: ["build", "dev", "test"],
    });
    await sandboxRuns.startScript(sandbox, "dev");
    await expect(runs.list("s")).resolves.toMatchObject([
      { command: "pnpm run dev", cwd: "/p/shop" },
    ]);
    await expect(sandboxRuns.startScript(sandbox, "nope")).rejects.toThrow(
      /no script nope/u
    );
  });

  it("reruns a run as a new one, and lists newest first", async () => {
    const { sandboxRuns } = setup();
    const first = await sandboxRuns.start(sandbox, "npm test", "/p/docs");
    const second = await sandboxRuns.rerun(sandbox, first);
    const listed = await sandboxRuns.list(sandbox);
    expect(listed.map(({ id }) => id)).toStrictEqual([second, first]);
    expect(listed[0]).toMatchObject({ command: "npm test", cwd: "/p/docs" });
  });

  it("starts a prompt in the main workspace, and refuses an empty one", async () => {
    const { runs, sandboxRuns } = setup();
    await sandboxRuns.startPrompt(sandbox, "--help");
    await expect(runs.list("s")).resolves.toMatchObject([
      { command: "claude -p -- --help", cwd: "/p/shop" },
    ]);
    await expect(sandboxRuns.startPrompt(sandbox, " ")).rejects.toThrow(
      /Type a prompt/u
    );
    await expect(
      sandboxRuns.startPrompt({ ...sandbox, agent: "gemini" }, "Go")
    ).rejects.toThrow(/can't take a prompt/u);
  });

  it("turns a prompt into the agent's one-shot command", () => {
    const { sandboxRuns } = setup();
    expect(sandboxRuns.promptCommand(sandbox, "Fix the 'cart'")).toBe(
      String.raw`claude -p -- 'Fix the '\''cart'\'''`
    );
    expect(
      sandboxRuns.promptCommand({ ...sandbox, agent: "codex" }, "Go")
    ).toBe("codex exec -- Go");
    expect(
      sandboxRuns.promptCommand({ ...sandbox, agent: "gemini" }, "Go")
    ).toBeUndefined();
  });
});
