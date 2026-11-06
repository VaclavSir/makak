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

const setupActive = () => {
  const runs = createFakeRuns();
  let at = Date.parse("2026-10-20T21:30:05Z");
  const asked: string[] = [];
  let failing = false;
  const sandboxRuns = createSandboxRuns({
    activeTtlMs: 1000,
    now: () => new Date(at),
    projects: [],
    runs: {
      ...runs,
      list: async (name) => {
        asked.push(name);
        if (failing) {
          throw new Error("sbx exec failed");
        }
        return await runs.list(name);
      },
    },
  });
  return {
    advance: (ms: number) => {
      at += ms;
    },
    asked,
    fail: (value: boolean) => {
      failing = value;
    },
    runs,
    sandboxRuns,
  };
};

describe("active runs", () => {
  const other: Sandbox = { ...sandbox, id: "id-2", name: "t" };

  it("lists each running sandbox's running runs, and skips stopped ones", async () => {
    const { asked, sandboxRuns } = setupActive();
    const id = await sandboxRuns.start(sandbox, "npm test", "/p/shop");
    await expect(
      sandboxRuns.active([sandbox, { ...other, status: "stopped" }])
    ).resolves.toStrictEqual({ "id-1": [{ command: "npm test", id }] });
    expect(asked).toStrictEqual(["s"]);
  });

  it("asks a sandbox once per interval, sharing an answer in progress", async () => {
    const { advance, asked, sandboxRuns } = setupActive();
    await Promise.all([
      sandboxRuns.active([sandbox]),
      sandboxRuns.active([sandbox]),
    ]);
    await sandboxRuns.active([sandbox]);
    expect(asked).toHaveLength(1);
    advance(1000);
    await sandboxRuns.active([sandbox]);
    expect(asked).toHaveLength(2);
  });

  it("counts the runs listed for the sandbox's page as asking", async () => {
    const { asked, sandboxRuns } = setupActive();
    await sandboxRuns.list(sandbox);
    await sandboxRuns.active([sandbox]);
    expect(asked).toStrictEqual(["s"]);
  });

  it("asks again after a run is started or stopped from the Panel", async () => {
    const { runs, sandboxRuns } = setupActive();
    await expect(sandboxRuns.active([sandbox])).resolves.toStrictEqual({
      "id-1": [],
    });
    const id = await sandboxRuns.start(sandbox, "npm test", "/p/shop");
    await expect(sandboxRuns.active([sandbox])).resolves.toStrictEqual({
      "id-1": [{ command: "npm test", id }],
    });
    await sandboxRuns.stop(sandbox, id);
    await expect(runs.list("s")).resolves.toMatchObject([{ state: "stopped" }]);
    await expect(sandboxRuns.active([sandbox])).resolves.toStrictEqual({
      "id-1": [],
    });
  });

  it("leaves out a sandbox that can't be asked, and asks it again next time", async () => {
    const { asked, fail, sandboxRuns } = setupActive();
    fail(true);
    await expect(sandboxRuns.active([sandbox, other])).resolves.toStrictEqual(
      {}
    );
    fail(false);
    await expect(sandboxRuns.active([sandbox, other])).resolves.toStrictEqual({
      "id-1": [],
      "id-2": [],
    });
    expect(asked).toStrictEqual(["s", "t", "s", "t"]);
  });
});
