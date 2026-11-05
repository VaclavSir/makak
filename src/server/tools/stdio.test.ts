import { describe, expect, it } from "vitest";

import { createFakeStdio, spawnStdio, stdioEnv } from "./stdio.ts";
import type { StdioCommand } from "./stdio.ts";

/** Runs Node with a script, collecting what it writes. */
const node = (script: string, env: Record<string, string> = {}) => {
  const lines: string[] = [];
  let stderr = "";
  const command: StdioCommand = {
    args: ["-e", script],
    command: process.execPath,
    cwd: undefined,
    env,
  };
  const child = spawnStdio(command, {
    onLine: (line) => lines.push(line),
    onStderr: (text) => {
      stderr += text;
    },
  });
  return { child, lines, stderr: () => stderr };
};

describe(spawnStdio, () => {
  it("passes lines both ways, and says how the process ended", async () => {
    const { child, lines, stderr } = node(`
      require("node:readline").createInterface({ input: process.stdin })
        .on("line", (line) => {
          console.log(line.toUpperCase());
          console.error("got " + line);
          if (line === "bye") process.exit(3);
        });
    `);
    child.send("hello");
    child.send("bye");

    await expect(child.exited).resolves.toBe("exited with code 3");
    expect(lines).toStrictEqual(["HELLO", "BYE"]);
    expect(stderr()).toBe("got hello\ngot bye\n");
  });

  it("gives the process only the base environment and its own", async () => {
    process.env.MAKAK_TEST_SECRET = "leaked";
    try {
      const { child, lines } = node(
        "console.log(JSON.stringify([process.env.MAKAK_TEST_SECRET, process.env.OWN, typeof process.env.PATH]))",
        { OWN: "mine" }
      );
      await child.exited;
      expect(lines).toStrictEqual(['[null,"mine","string"]']);
    } finally {
      delete process.env.MAKAK_TEST_SECRET;
    }
  });

  it("stops a process, and says when one can't run", async () => {
    const { child } = node("setInterval(() => {}, 1000)");
    child.kill();
    await expect(child.exited).resolves.toBe("stopped by SIGTERM");

    const missing = spawnStdio(
      { args: [], command: "makak-no-such-command", cwd: undefined, env: {} },
      { onLine: () => {}, onStderr: () => {} }
    );
    missing.send("ignored");
    await expect(missing.exited).resolves.toBe(
      "makak-no-such-command is not installed or not on PATH"
    );
  });
});

describe(stdioEnv, () => {
  it("keeps the base variables, then adds the server's own", () => {
    expect(
      stdioEnv(
        { HOME: "/override", TOKEN: "t" },
        {
          HOME: "/home/me",
          PATH: "/bin",
          SECRET: "s",
        }
      )
    ).toStrictEqual({ HOME: "/override", PATH: "/bin", TOKEN: "t" });
  });
});

describe(createFakeStdio, () => {
  it("answers like a small MCP server", async () => {
    const lines: string[] = [];
    const child = createFakeStdio()(
      { args: [], command: "fake", cwd: undefined, env: {} },
      { onLine: (line) => lines.push(line), onStderr: () => {} }
    );
    child.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    child.send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    child.send(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"a":1}}}'
    );
    await Promise.resolve();

    expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
      { id: 1, result: { serverInfo: { name: "(fake) fake" } } },
      { id: 2, result: { content: [{ text: '{"a":1}' }] } },
    ]);
    child.kill();
    await expect(child.exited).resolves.toBe("stopped by SIGTERM");
  });
});
