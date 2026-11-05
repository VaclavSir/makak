import { describe, expect, it } from "vitest";

import { createMcpHealth, messageFor, reasonOf } from "./health.ts";
import type { McpServer } from "./proxy.ts";
import { SignedOutError } from "./upstream.ts";
import type { Upstream, UpstreamRequest } from "./upstream.ts";

const SERVER: McpServer = {
  allow: [],
  headers: {},
  holdMs: 1000,
  name: "gitlab",
  url: "https://gitlab.test/mcp",
};

const json = (body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { headers });

/** Never answers, until the check gives up. */
const slow: Upstream = async (_server, { signal }) =>
  // oxlint-disable-next-line promise/avoid-new -- held until aborted
  await new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(signal.reason);
    });
  });

const signedOut: Upstream = () => Promise.reject(new SignedOutError());

// Node's fetch keeps the reason as the cause.
const down: Upstream = () =>
  Promise.reject(
    new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:1"),
    })
  );

const TOOLS = [
  {
    annotations: { readOnlyHint: true },
    description: "Reads an issue.",
    name: "get_issue",
  },
  { description: "Comments on an issue.", name: "create_note" },
];

/**
 * A stand-in server answering the way MCP servers do, recording each
 * request; `answer` overrides the answer to one method.
 */
const fakeServer = (
  answer: Record<string, (id: unknown) => Response | Promise<Response>> = {}
) => {
  const requests: (UpstreamRequest & { rpc?: string })[] = [];
  const upstream: Upstream = (_server, request) => {
    const message =
      request.body === undefined
        ? undefined
        : (JSON.parse(request.body) as { id?: unknown; method: string });
    requests.push({ ...request, rpc: message?.method });
    if (message === undefined) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    const custom = answer[message.method];
    if (custom !== undefined) {
      return Promise.resolve(custom(message.id));
    }
    switch (message.method) {
      case "initialize": {
        return Promise.resolve(
          json(
            {
              id: message.id,
              jsonrpc: "2.0",
              result: { protocolVersion: "2025-03-26" },
            },
            { "mcp-session-id": "s-1" }
          )
        );
      }
      case "tools/list": {
        return Promise.resolve(
          json({ id: message.id, jsonrpc: "2.0", result: { tools: TOOLS } })
        );
      }
      default: {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
    }
  };
  return { requests, upstream };
};

const healthOf = (upstream: Upstream, now = () => 0) =>
  createMcpHealth({ now, servers: [SERVER], timeoutMs: 200, upstream });

describe(createMcpHealth, () => {
  it("initializes a session, lists the tools and ends the session", async () => {
    const { requests, upstream } = fakeServer();
    const result = await healthOf(upstream).check("gitlab");

    expect(result).toStrictEqual({
      at: "1970-01-01T00:00:00.000Z",
      ok: true,
      tools: [
        { description: "Reads an issue.", name: "get_issue", readOnly: true },
        {
          description: "Comments on an issue.",
          name: "create_note",
          readOnly: false,
        },
      ],
    });
    expect(
      requests.map(({ headers, method, rpc }) => [
        method,
        rpc,
        headers["mcp-session-id"],
      ])
    ).toStrictEqual([
      ["POST", "initialize", undefined],
      ["POST", "notifications/initialized", "s-1"],
      ["POST", "tools/list", "s-1"],
      ["DELETE", undefined, "s-1"],
    ]);
    // The version the server chose, from then on.
    expect(requests[2]?.headers["mcp-protocol-version"]).toBe("2025-03-26");
  });

  it("reads answers sent as events, and every page of tools", async () => {
    let pages = 0;
    const { upstream } = fakeServer({
      "tools/list": (id) => {
        pages += 1;
        const result =
          pages === 1
            ? { nextCursor: "2", tools: [TOOLS[0]] }
            : { tools: [TOOLS[1]] };
        return new Response(
          `: ping\n\nevent: message\ndata: ${JSON.stringify({ id, jsonrpc: "2.0", result })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      },
    });

    const result = await healthOf(upstream).check("gitlab");
    expect(result.ok && result.tools.map(({ name }) => name)).toStrictEqual([
      "get_issue",
      "create_note",
    ]);
  });

  it("says why the server refused, in its own words", async () => {
    const { upstream } = fakeServer({
      initialize: () =>
        new Response(
          '{"message":"403 Forbidden - MCP server not enabled for any of your groups"}',
          { status: 403 }
        ),
    });

    await expect(healthOf(upstream).check("gitlab")).resolves.toMatchObject({
      ok: false,
      reason:
        "HTTP 403: 403 Forbidden - MCP server not enabled for any of your groups",
    });
  });

  it("says when the server refuses a method, or doesn't answer it", async () => {
    const refusing = fakeServer({
      "tools/list": (id) =>
        json({ error: { code: -32_601, message: "No tools here" }, id }),
    });
    await expect(
      healthOf(refusing.upstream).check("gitlab")
    ).resolves.toMatchObject({
      reason: "The server refused tools/list: No tools here",
    });

    const silent = fakeServer({ "tools/list": () => json({ id: 99 }) });
    await expect(
      healthOf(silent.upstream).check("gitlab")
    ).resolves.toMatchObject({
      reason: "The server didn't answer tools/list.",
    });
  });

  it("says when the Panel isn't signed in, or the server can't be reached", async () => {
    await expect(healthOf(signedOut).check("gitlab")).resolves.toMatchObject({
      reason: "The Panel isn't signed in to it.",
    });

    await expect(healthOf(down).check("gitlab")).resolves.toMatchObject({
      reason: "It can't be reached: connect ECONNREFUSED 127.0.0.1:1",
    });

    await expect(healthOf(slow).check("gitlab")).resolves.toMatchObject({
      reason: "It didn't answer within 0.2 seconds.",
    });
  });

  it("joins a check already running, and keeps the result", async () => {
    const { requests, upstream } = fakeServer();
    const health = healthOf(upstream);

    const [first, second] = await Promise.all([
      health.check("gitlab"),
      health.check("gitlab"),
    ]);
    expect(second).toBe(first);
    expect(requests.filter(({ rpc }) => rpc === "initialize")).toHaveLength(1);
    expect(health.status("gitlab").check).toBe(first);
    expect(health.status("linear")).toStrictEqual({
      check: undefined,
      lastError: undefined,
    });
  });

  it("keeps the last error a server gave", () => {
    let clock = 1000;
    const health = healthOf(fakeServer().upstream, () => clock);

    health.noteError("gitlab", "HTTP 500: oops");
    clock = 2000;
    expect(health.status("gitlab").lastError).toStrictEqual({
      at: "1970-01-01T00:00:01.000Z",
      message: "HTTP 500: oops",
    });
    expect(health.errorSince("gitlab", 1000)?.message).toBe("HTTP 500: oops");
    expect(health.errorSince("gitlab", 1001)).toBeUndefined();
  });
});

describe(reasonOf, () => {
  it("takes the usual fields", () => {
    expect(reasonOf('{"error_description":"bad token"}')).toBe("bad token");
    expect(reasonOf('{"message":"403 Forbidden"}')).toBe("403 Forbidden");
    expect(reasonOf('{"error":{"code":1,"message":"nope"}}')).toBe("nope");
    expect(reasonOf('{"error":"invalid_token"}')).toBe("invalid_token");
  });

  it("takes the text otherwise", () => {
    expect(reasonOf("  Bad gateway\n")).toBe("Bad gateway");
    expect(reasonOf("")).toBe("no reason given");
  });
});

describe(messageFor, () => {
  it("finds the answer in JSON or in events", () => {
    const answer = { id: 2, jsonrpc: "2.0", result: {} };
    expect(
      messageFor(JSON.stringify(answer), "application/json", 2)
    ).toStrictEqual(answer);
    expect(
      messageFor(
        `data: {"jsonrpc":"2.0","method":"notifications/message"}\n\ndata: ${JSON.stringify(answer)}\n\n`,
        "text/event-stream",
        2
      )
    ).toStrictEqual(answer);
    expect(messageFor("{}", "application/json", 2)).toBeUndefined();
  });
});
