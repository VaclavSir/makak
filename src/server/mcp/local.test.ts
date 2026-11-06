import { describe, expect, it } from "vitest";

import { createFakeStdio, spawnStdio } from "../tools/stdio.ts";
import type { SpawnStdio, StdioHandlers } from "../tools/stdio.ts";
import { createLocalServers } from "./local.ts";
import type { McpServer } from "./proxy.ts";
import type { UpstreamRequest } from "./upstream.ts";

const SERVER: McpServer = {
  allow: [],
  headers: {},
  holdMs: 1000,
  local: { args: ["server.js"], command: "node", cwd: undefined, env: {} },
  name: "notes",
};

const rpc = (id: number | undefined, method: string, params?: unknown) =>
  JSON.stringify({ id, jsonrpc: "2.0", method, params });

/** A process the test drives: it records what it's sent, and answers only when told. */
const scripted = () => {
  const processes: {
    end: (how: string) => void;
    handlers: StdioHandlers;
    killed: boolean;
    sent: string[];
  }[] = [];
  const spawn: SpawnStdio = (_command, handlers) => {
    const exited = Promise.withResolvers<string>();
    const process = {
      end: exited.resolve,
      handlers,
      killed: false,
      sent: [] as string[],
    };
    processes.push(process);
    return {
      exited: exited.promise,
      kill: () => {
        process.killed = true;
        exited.resolve("stopped by SIGTERM");
      },
      send: (line) => process.sent.push(line),
    };
  };
  return { processes, spawn };
};

let sessions = 0;
const local = (spawn: SpawnStdio = createFakeStdio()) => {
  sessions = 0;
  return createLocalServers({
    newSessionId: () => {
      sessions += 1;
      return `s${sessions}`;
    },
    spawn,
  });
};

const post = (
  body: string,
  session?: string,
  signal?: AbortSignal
): UpstreamRequest => ({
  body,
  headers: session === undefined ? {} : { "mcp-session-id": session },
  method: "POST",
  signal,
});

describe(createLocalServers, () => {
  it("starts a process per session, and answers through it", async () => {
    const servers = local();
    const init = await servers.request(SERVER, post(rpc(1, "initialize")));
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBe("s1");
    await expect(init.json()).resolves.toMatchObject({
      id: 1,
      result: { serverInfo: { name: "(fake) node" } },
    });

    const noted = await servers.request(
      SERVER,
      post(rpc(undefined, "notifications/initialized"), "s1")
    );
    expect(noted.status).toBe(202);
    const call = await servers.request(
      SERVER,
      post(rpc(2, "tools/call", { arguments: { a: 1 }, name: "echo" }), "s1")
    );
    await expect(call.json()).resolves.toMatchObject({
      id: 2,
      result: { content: [{ text: '{"a":1}' }] },
    });
  });

  it("gives each session a process of its own", async () => {
    const servers = local();
    await servers.request(SERVER, post(rpc(1, "initialize")));
    const second = await servers.request(SERVER, post(rpc(1, "initialize")));
    expect(second.headers.get("mcp-session-id")).toBe("s2");
    expect(servers.status("notes").processes).toBe(2);
  });

  it("answers a batch with a batch", async () => {
    const servers = local();
    await servers.request(SERVER, post(rpc(1, "initialize")));
    const answer = await servers.request(
      SERVER,
      post(`[${rpc(2, "ping")},${rpc(3, "tools/list")}]`, "s1")
    );
    await expect(answer.json()).resolves.toMatchObject([
      { id: 2 },
      { id: 3, result: { tools: [{ name: "echo" }] } },
    ]);
  });

  it("stops a session's process when the session ends, or the Panel does", async () => {
    const { processes, spawn } = scripted();
    const servers = local(spawn);
    const starting = servers.request(SERVER, post(rpc(1, "initialize")));
    processes[0]?.handlers.onLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    await starting;

    const ended = await servers.request(SERVER, {
      headers: { "mcp-session-id": "s1" },
      method: "DELETE",
    });
    expect(ended.status).toBe(200);
    expect(processes[0]?.killed).toBeTruthy();
    await Promise.resolve();
    expect(servers.status("notes").processes).toBe(0);

    const again = servers.request(SERVER, post(rpc(1, "initialize")));
    processes[1]?.handlers.onLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    await again;
    servers.stopAll();
    expect(processes[1]?.killed).toBeTruthy();
  });

  it("sends an unknown session's client to start a new one", async () => {
    const servers = local();
    await servers.request(SERVER, post(rpc(1, "initialize")));
    const other = { ...SERVER, name: "other" };

    for (const answer of [
      await servers.request(SERVER, post(rpc(2, "ping"), "nope")),
      await servers.request(SERVER, post(rpc(2, "ping"))),
      await servers.request(other, post(rpc(2, "ping"), "s1")),
      await servers.request(SERVER, { headers: {}, method: "GET" }),
    ]) {
      expect(answer.status).toBe(404);
    }
  });

  it("says when the process ends before answering, and keeps its output", async () => {
    const { processes, spawn } = scripted();
    const servers = local(spawn);
    const starting = servers.request(SERVER, post(rpc(1, "initialize")));
    processes[0]?.handlers.onStderr("Error: no DATABASE_URL\n");
    processes[0]?.handlers.onLine("not json, logged by mistake");
    processes[0]?.end("exited with code 1");

    const answer = await starting;
    expect(answer.status).toBe(502);
    await expect(answer.json()).resolves.toMatchObject({
      error: {
        message:
          "The local notes server ended before answering (exited with code 1). Its output is on the MCP servers page.",
      },
    });
    expect(servers.status("notes")).toStrictEqual({
      processes: 0,
      stderr: [
        "Error: no DATABASE_URL",
        "not json, logged by mistake",
        "(exited with code 1)",
      ],
    });
  });

  it("keeps only the end of a server's output", () => {
    const { processes, spawn } = scripted();
    const servers = local(spawn);
    void servers.request(SERVER, post(rpc(1, "initialize")));
    for (let line = 1; line <= 60; line += 1) {
      processes[0]?.handlers.onStderr(`line ${line}\n`);
    }
    const { stderr } = servers.status("notes");
    expect(stderr).toHaveLength(50);
    expect(stderr[0]).toBe("line 11");
  });

  it("streams the server's own messages to the session's GET", async () => {
    const { processes, spawn } = scripted();
    const servers = local(spawn);
    const starting = servers.request(SERVER, post(rpc(1, "initialize")));
    processes[0]?.handlers.onLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    await starting;

    const controller = new AbortController();
    const stream = await servers.request(SERVER, {
      headers: { "mcp-session-id": "s1" },
      method: "GET",
      signal: controller.signal,
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const note =
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}';
    processes[0]?.handlers.onLine(note);
    controller.abort();
    await expect(stream.text()).resolves.toBe(
      `event: message\ndata: ${note}\n\n`
    );
  });

  it("stops waiting when the caller hangs up", async () => {
    const { processes, spawn } = scripted();
    const servers = local(spawn);
    const starting = servers.request(SERVER, post(rpc(1, "initialize")));
    processes[0]?.handlers.onLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    await starting;

    const controller = new AbortController();
    const waiting = servers.request(
      SERVER,
      post(rpc(2, "tools/call"), "s1", controller.signal)
    );
    controller.abort();
    await expect(waiting).rejects.toThrow(/abort/iu);
    expect(processes[0]?.killed).toBeFalsy();
  });

  it("talks to a real process, one message per line", async () => {
    // A tiny stdio MCP server: answers initialize, and lists one tool.
    const script = `
      require("node:readline").createInterface({ input: process.stdin })
        .on("line", (line) => {
          const { id, method } = JSON.parse(line);
          if (id === undefined) return;
          const result = method === "initialize"
            ? { protocolVersion: "2025-06-18", serverInfo: { name: "tiny" } }
            : { tools: [{ name: "now" }] };
          console.error("answering " + method);
          console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
        });
    `;
    const servers = createLocalServers({ spawn: spawnStdio });
    const tiny = {
      ...SERVER,
      local: {
        args: ["-e", script],
        command: process.execPath,
        cwd: undefined,
        env: {},
      },
    };
    const init = await servers.request(tiny, post(rpc(1, "initialize")));
    const session = init.headers.get("mcp-session-id") ?? "";
    const tools = await servers.request(
      tiny,
      post(rpc(2, "tools/list"), session)
    );
    await expect(tools.json()).resolves.toMatchObject({
      result: { tools: [{ name: "now" }] },
    });

    servers.stopAll();
    await expect
      .poll(() => servers.status("notes"))
      .toStrictEqual({
        processes: 0,
        stderr: [
          "answering initialize",
          "answering tools/list",
          "(stopped by SIGTERM)",
        ],
      });
  });
});
