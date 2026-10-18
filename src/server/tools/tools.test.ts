import { describe, expect, it } from "vitest";

import { CommandError, exec, execChecked } from "./exec.ts";
import type { CommandResult, Exec } from "./exec.ts";
import { createFakeTools, createTools } from "./index.ts";

const PRINT_ARGS =
  "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

describe(exec, () => {
  it("passes arguments verbatim, without a shell", async () => {
    const hostile = ["$(touch /tmp/pwned)", "; rm -rf /", "a b", "'\"`"];
    const { exitCode, stdout } = await exec(process.execPath, [
      "-e",
      PRINT_ARGS,
      ...hostile,
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toStrictEqual(hostile);
  });

  it("resolves with the exit code and output of a failing command", async () => {
    const result = await exec(process.execPath, [
      "-e",
      "process.stderr.write('bad'); process.exit(3)",
    ]);
    expect(result).toStrictEqual({ exitCode: 3, stderr: "bad", stdout: "" });
  });

  it("rejects when the command does not exist", async () => {
    await expect(exec("makak-no-such-command", [])).rejects.toThrow(
      /not installed or not on PATH/u
    );
  });
});

const failing: Exec = () =>
  Promise.resolve({ exitCode: 1, stderr: "no such sandbox\n", stdout: "" });

describe(execChecked, () => {
  it("rejects on a non-zero exit, with stderr", async () => {
    await expect(execChecked(failing, "sbx", ["ls"])).rejects.toThrow(
      new CommandError("`sbx ls` failed: no such sandbox")
    );
  });
});

const recording = (result: Partial<CommandResult> = {}) => {
  const calls: [string, readonly string[]][] = [];
  const run: Exec = (command, args) => {
    calls.push([command, args]);
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "", ...result });
  };
  return { calls, run };
};

describe(createTools, () => {
  it("reports the first line of sbx and git versions", async () => {
    const { calls, run } = recording({
      stdout: "Version: 1.2.3\nBuild: abc\n",
    });
    const tools = createTools(run);

    await expect(tools.sbx.version()).resolves.toBe("Version: 1.2.3");
    await expect(tools.git.version()).resolves.toBe("Version: 1.2.3");
    expect(calls).toStrictEqual([
      ["sbx", ["version"]],
      ["git", ["--version"]],
    ]);
  });

  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)("opens the browser on %s with %s", async (platform, command) => {
    const { calls, run } = recording();
    await createTools(run, platform).browser.open(
      "https://makakctl.test:7443/"
    );
    expect(calls).toStrictEqual([[command, ["https://makakctl.test:7443/"]]]);
  });

  it("refuses to open a browser on unsupported platforms", async () => {
    const { run } = recording();
    await expect(
      createTools(run, "win32").browser.open("https://x.test/")
    ).rejects.toThrow(/not supported/u);
  });
});

describe(createFakeTools, () => {
  it("answers without running anything", async () => {
    const opened: string[] = [];
    const tools = createFakeTools({
      open: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });

    await expect(tools.sbx.version()).resolves.toMatch(/fake/u);
    await expect(tools.git.version()).resolves.toMatch(/fake/u);
    await tools.browser.open("https://x.test/");
    expect(opened).toStrictEqual(["https://x.test/"]);
  });
});
