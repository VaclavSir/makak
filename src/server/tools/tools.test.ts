import { describe, expect, it } from "vitest";

import { CommandError, exec, execChecked, stream } from "./exec.ts";
import type { CommandResult, Exec } from "./exec.ts";
import { createFakeSbx, createFakeTools, createTools } from "./index.ts";

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

  it("kills a command that runs too long", async () => {
    await expect(
      exec(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
        timeoutMs: 100,
      })
    ).rejects.toThrow(/timed out after 0.1s/u);
  });

  it("writes the input to stdin, and closes it without", async () => {
    const echo = "process.stdin.pipe(process.stdout)";
    await expect(
      exec(process.execPath, ["-e", echo], { input: "secret" })
    ).resolves.toMatchObject({ stdout: "secret" });
    await expect(
      exec(process.execPath, ["-e", echo], { timeoutMs: 5000 })
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("rejects when the command does not exist", async () => {
    await expect(exec("makak-no-such-command", [])).rejects.toThrow(
      /not installed or not on PATH/u
    );
  });
});

const failing: Exec = () =>
  Promise.resolve({ exitCode: 1, stderr: "no such sandbox\n", stdout: "" });

/** Node running a script, streamed. */
const node = (script: string) => stream(process.execPath, ["-e", script]);

describe(stream, () => {
  it("passes on the output as it comes", async () => {
    await expect(
      new Response(
        node("process.stdout.write('a'); process.stdout.write('b')")
      ).text()
    ).resolves.toBe("ab");
  });

  it("errors with stderr when the command fails", async () => {
    await expect(
      new Response(
        node("process.stderr.write('no run x'); process.exit(2)")
      ).text()
    ).rejects.toThrow(`\`${process.execPath}\` failed: no run x`);
  });

  it("can be cancelled while the command runs, without errors after", async () => {
    const reader = node(
      "process.stdout.write('first'); setInterval(() => process.stdout.write('more'), 10)"
    ).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("first");
    await reader.cancel();
    // The command's exit, after the cancel, must not touch the stream.
    // oxlint-disable-next-line promise/avoid-new -- waits for the exit
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  });
});

describe(execChecked, () => {
  it("rejects on a non-zero exit, with stderr", async () => {
    await expect(execChecked(failing, "sbx", ["ls"])).rejects.toThrow(
      new CommandError("`sbx ls` failed: no such sandbox")
    );
  });
});

const recording = (result: Partial<CommandResult> = {}) => {
  const calls: [string, readonly string[]][] = [];
  const inputs: (string | undefined)[] = [];
  const run: Exec = (command, args, options) => {
    calls.push([command, args]);
    inputs.push(options?.input);
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "", ...result });
  };
  return { calls, inputs, run };
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

  it("lists sandboxes with sbx ls --json", async () => {
    const { calls, run } = recording({
      stdout: '[{"name": "a", "id": "1", "status": "running"}]',
    });

    await expect(createTools(run).sbx.list()).resolves.toMatchObject([
      { id: "1", name: "a", status: "running" },
    ]);
    expect(calls).toStrictEqual([["sbx", ["ls", "--json"]]]);
  });

  const spec = {
    args: { project: "/p", sandbox: "feature-a" },
    files: ["/envs/00-base.sbxenv.yaml", "/envs/20-web.sbxenv.yaml"],
    name: "feature-a",
  };

  it("runs sbx env commands with flags as --flag=value and files last", async () => {
    const { calls, run } = recording({ stdout: "+ sandbox\n" });
    const tools = createTools(run);

    await expect(tools.sbx.envPlan(spec)).resolves.toBe("+ sandbox");
    await tools.sbx.envRun(spec);
    await tools.sbx.envRm(spec);
    const flags = [
      "--name=feature-a",
      "--env-arg=project=/p",
      "--env-arg=sandbox=feature-a",
      "/envs/00-base.sbxenv.yaml",
      "/envs/20-web.sbxenv.yaml",
    ];
    expect(calls).toStrictEqual([
      ["sbx", ["env", "plan", ...flags]],
      ["sbx", ["env", "run", "--detach", "--force", ...flags]],
      ["sbx", ["env", "rm", "--force", ...flags]],
    ]);
  });

  it("refuses relative env file paths", async () => {
    const { calls, run } = recording();
    await expect(
      createTools(run).sbx.envPlan({ ...spec, files: ["base.sbxenv.yaml"] })
    ).rejects.toThrow(/must be absolute/u);
    expect(calls).toStrictEqual([]);
  });

  it("starts, stops and removes sandboxes by name, never as a flag", async () => {
    const { calls, run } = recording();
    const tools = createTools(run);

    await tools.sbx.start("-x");
    await tools.sbx.stop("-x");
    await tools.sbx.rm("-x");
    expect(calls).toStrictEqual([
      ["sbx", ["run", "--detach", "--name=-x"]],
      ["sbx", ["stop", "--", "-x"]],
      ["sbx", ["rm", "--force", "--", "-x"]],
    ]);
  });

  it("registers, lists, loads and removes MCP servers, names never as flags", async () => {
    const { calls, run } = recording({ stdout: "[]" });
    const tools = createTools(run);

    await tools.sbx.mcpAdd({
      // oxlint-disable-next-line no-template-curly-in-string -- sbx's placeholder
      headers: ["Authorization: Bearer ${token}"],
      name: "-x",
      url: "https://makakctl.test/mcp/a/b",
    });
    await tools.sbx.mcpLoad("-x", "-y");
    await tools.sbx.mcpRm("-x");
    await tools.sbx.mcpList();
    expect(calls).toStrictEqual([
      [
        "sbx",
        [
          "mcp",
          "add",
          "--url=https://makakctl.test/mcp/a/b",
          // oxlint-disable-next-line no-template-curly-in-string -- sbx's placeholder
          "--header=Authorization: Bearer ${token}",
          "--skip-ssrf-check",
          "--",
          "-x",
        ],
      ],
      ["sbx", ["mcp", "load", "--sandbox=-y", "--", "-x"]],
      ["sbx", ["mcp", "rm", "--force", "--", "-x"]],
      ["sbx", ["mcp", "ls", "--json"]],
    ]);
  });

  it("passes a secret on stdin, never as an argument", async () => {
    const { calls, inputs, run } = recording();
    const tools = createTools(run);

    await tools.sbx.secretSet("mcp:a-b:token", "s3cret");
    await tools.sbx.secretRm("mcp:a-b:token");
    expect(calls).toStrictEqual([
      ["sbx", ["secret", "set", "--force", "--", "mcp:a-b:token"]],
      ["sbx", ["secret", "rm", "--force", "--", "mcp:a-b:token"]],
    ]);
    expect(inputs).toStrictEqual(["s3cret", undefined]);
  });

  it("reports everything sbx printed when it fails", async () => {
    const { run } = recording({
      exitCode: 1,
      stderr: "error: arg project is required\n",
      stdout: "Planning…\n",
    });
    await expect(createTools(run).sbx.envPlan(spec)).rejects.toThrow(
      /failed:\nPlanning…\nerror: arg project is required$/u
    );
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

describe(createFakeSbx, () => {
  it("remembers what is created, stopped and removed", async () => {
    const sbx = createFakeSbx();
    const statusOf = async (name: string) => {
      const sandboxes = await sbx.list();
      return sandboxes.find((sandbox) => sandbox.name === name)?.status;
    };

    await sbx.envRun({ args: {}, files: ["/e.sbxenv.yaml"], name: "new" });
    await expect(statusOf("new")).resolves.toBe("running");
    await sbx.stop("new");
    await expect(statusOf("new")).resolves.toBe("stopped");
    await sbx.start("new");
    await expect(statusOf("new")).resolves.toBe("running");
    await sbx.rm("new");
    await expect(statusOf("new")).resolves.toBeUndefined();
    await expect(sbx.stop("new")).rejects.toThrow(/no sandbox named new/u);
  });

  it("reports a registered server usable once its header secret is set", async () => {
    const sbx = createFakeSbx();
    await sbx.mcpAdd({
      // oxlint-disable-next-line no-template-curly-in-string -- sbx's placeholder
      headers: ["Authorization: Bearer ${token}"],
      name: "gitlab",
      url: "https://makakctl.test/mcp/gitlab",
    });
    await expect(sbx.mcpList()).resolves.toMatchObject([
      { nextStep: "sbx secret set mcp:gitlab:token", status: "needs-secret" },
    ]);
    await sbx.secretSet("mcp:gitlab:token", "t");
    await expect(sbx.mcpList()).resolves.toMatchObject([
      { name: "gitlab", status: "ready" },
    ]);
    await expect(
      sbx.mcpAdd({ headers: [], name: "gitlab", url: "https://x.test/" })
    ).rejects.toThrow(/already exists/u);
    await sbx.mcpRm("gitlab");
    await expect(sbx.mcpList()).resolves.toStrictEqual([]);
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
