import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exec, stream } from "./exec.ts";
import {
  createFakeRuns,
  createRuns,
  parsePackage,
  parseRunList,
  RUN_HELPER,
} from "./runs.ts";
import type { Runs } from "./runs.ts";

const text = async (body: ReadableStream<Uint8Array>) =>
  await new Response(body).text();

const base64 = (value: string) => Buffer.from(value).toString("base64");

describe(parseRunList, () => {
  it("reads the helper's lines, oldest first", () => {
    expect(
      parseRunList(
        [
          `b\t2026-10-20T10:01:00Z\trunning\t\t12\t${base64("npm start\n")}\t${base64("/w")}`,
          `a\t2026-10-20T10:00:00Z\texited\t3\t0\t${base64("echo 'a\tb'\n")}\t${base64("/w")}`,
          "",
        ].join("\n")
      )
    ).toStrictEqual([
      {
        command: "echo 'a\tb'",
        cwd: "/w",
        exitCode: 3,
        id: "a",
        logSize: 0,
        startedAt: "2026-10-20T10:00:00Z",
        state: "exited",
      },
      {
        command: "npm start",
        cwd: "/w",
        exitCode: undefined,
        id: "b",
        logSize: 12,
        startedAt: "2026-10-20T10:01:00Z",
        state: "running",
      },
    ]);
  });

  it("skips lines it can't read", () => {
    expect(parseRunList("garbage\nx\ty\tbroken\t\t0\t\t")).toStrictEqual([]);
  });
});

describe(parsePackage, () => {
  it("reads the package manager and the scripts", () => {
    expect(
      parsePackage(
        'pnpm\n{"scripts": {"dev": "vite dev", "odd": 1}, "name": "x"}'
      )
    ).toStrictEqual({ manager: "pnpm", scripts: { dev: "vite dev" } });
  });

  it.each([
    ["no package.json", ""],
    ["invalid JSON", "npm\n{"],
  ])("finds nothing with %s", (_, output) => {
    expect(parsePackage(output)).toBeUndefined();
  });

  it("finds no scripts in a package.json without them", () => {
    expect(parsePackage('npm\n{"name": "x"}')).toStrictEqual({
      manager: "npm",
      scripts: {},
    });
  });
});

/** `sh` running the helper, as `sbx exec` does in a sandbox. */
const args = (helperArgs: string[]) => [
  "-c",
  RUN_HELPER,
  "makak-run",
  ...helperArgs,
];

describe("the run helper, run locally", () => {
  let home: string;
  let work: string;
  let runs: Runs;

  /** Waits until the run is no longer running. */
  const finished = async (id: string) => {
    for (let tries = 0; tries < 100; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling
      const listed = await runs.list("s");
      const run = listed.find((each) => each.id === id);
      if (run?.state !== "running") {
        return run;
      }
      // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- polling
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    throw new Error(`${id} is still running`);
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "makak-runs-"));
    work = path.join(home, "work");
    await mkdir(work);
    runs = createRuns({
      exec: (_, helperArgs) =>
        exec("sh", args(helperArgs), { env: { HOME: home } }),
      stream: (_, helperArgs, signal) =>
        stream("sh", args(helperArgs), { env: { HOME: home }, signal }),
    });
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  it("runs a command in its directory, keeping its output and exit code", async () => {
    await runs.start("s", {
      command: "pwd; printf '\\rhalf\\rdone\\n'; echo \"$COLUMNS\"; exit 3",
      cwd: work,
      id: "r1",
    });
    await expect(finished("r1")).resolves.toMatchObject({
      command: "pwd; printf '\\rhalf\\rdone\\n'; echo \"$COLUMNS\"; exit 3",
      cwd: work,
      exitCode: 3,
      state: "exited",
    });
    const log = await text(runs.log("s", "r1", { follow: false, offset: 0 }));
    expect(log).toBe(`${work}\n\rhalf\rdone\n120\n`);
    await expect(
      text(runs.log("s", "r1", { follow: false, offset: work.length + 1 }))
    ).resolves.toBe("\rhalf\rdone\n120\n");
  });

  it("follows the log until the run ends", async () => {
    await runs.start("s", {
      command: "echo one; sleep 0.5; echo two",
      cwd: work,
      id: "r1",
    });
    await expect(
      text(runs.log("s", "r1", { follow: true, offset: 0 }))
    ).resolves.toBe("one\ntwo\n");
  });

  it("stops a run and everything it started", async () => {
    await runs.start("s", {
      command: "sleep 30 & echo started; wait",
      cwd: work,
      id: "r1",
    });
    await expect(runs.list("s")).resolves.toMatchObject([
      { id: "r1", state: "running" },
    ]);
    await runs.stop("s", "r1");
    await expect(finished("r1")).resolves.toMatchObject({
      exitCode: 143,
      state: "stopped",
    });
  });

  it("reports a directory it can't enter", async () => {
    await runs.start("s", {
      command: "true",
      cwd: path.join(home, "missing"),
      id: "r1",
    });
    await expect(finished("r1")).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      text(runs.log("s", "r1", { follow: false, offset: 0 }))
    ).resolves.toMatch(/cannot enter/u);
  });

  it("refuses a run id twice, and ids that aren't plain", async () => {
    await runs.start("s", { command: "true", cwd: work, id: "r1" });
    await expect(
      runs.start("s", { command: "true", cwd: work, id: "r1" })
    ).rejects.toThrow(/exists/u);
    await expect(
      runs.start("s", { command: "true", cwd: work, id: "../x" })
    ).rejects.toThrow(/Not a run id/u);
  });

  it("finds the package manager and scripts", async () => {
    await expect(runs.packageScripts("s", work)).resolves.toBeUndefined();
    await writeFile(
      path.join(work, "package.json"),
      '{"scripts": {"dev": "vite dev"}}'
    );
    await writeFile(path.join(work, "pnpm-lock.yaml"), "");
    await expect(runs.packageScripts("s", work)).resolves.toStrictEqual({
      manager: "pnpm",
      scripts: { dev: "vite dev" },
    });
  });

  it("fails reading the log of a run that doesn't exist", async () => {
    await expect(
      text(runs.log("s", "nope", { follow: false, offset: 0 }))
    ).rejects.toThrow(/no run nope/u);
  });

  it("lists nothing before the first run", async () => {
    await expect(runs.list("s")).resolves.toStrictEqual([]);
  });
});

describe(createFakeRuns, () => {
  it("runs a fake command with a progress bar, and stops it", async () => {
    const runs = createFakeRuns();
    await runs.start("s", { command: "npm start", cwd: "/w", id: "r1" });
    await expect(runs.list("s")).resolves.toMatchObject([
      { command: "npm start", id: "r1", state: "running" },
    ]);
    await runs.stop("s", "r1");
    await expect(runs.list("s")).resolves.toMatchObject([
      { exitCode: 143, state: "stopped" },
    ]);
    await expect(
      text(runs.log("s", "r1", { follow: true, offset: 0 }))
    ).resolves.toMatch(/\$ npm start[\s\S]*\^C/u);
  });
});
