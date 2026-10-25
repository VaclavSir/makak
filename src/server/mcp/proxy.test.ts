import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApprovals } from "./approvals.ts";
import type { Approvals } from "./approvals.ts";
import { createAudit } from "./audit.ts";
import type { Audit } from "./audit.ts";
import { createMcpProxy, MCP_PATH } from "./proxy.ts";
import type { McpServer } from "./proxy.ts";
import { createMcpStore } from "./store.ts";
import type { McpStore } from "./store.ts";

const A = { id: "id-a", name: "feature-a" };
const B = { id: "id-b", name: "feature-b" };

interface Received {
  body: unknown;
  headers: IncomingHttpHeaders;
  method: string | undefined;
}

const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** A stand-in MCP server that answers every request and records it. */
const upstream = () => {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) {
      text += String(chunk);
    }
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    received.push({ body, headers: req.headers, method: req.method });
    if (req.headers.authorization === "Bearer stale") {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end();
      return;
    }
    const id = (body as { id?: unknown } | undefined)?.id ?? null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": "session-1",
      "WWW-Authenticate": "Bearer realm=upstream",
    });
    res.end(
      JSON.stringify({
        id,
        jsonrpc: "2.0",
        result: { content: [{ text: "upstream", type: "text" }] },
      })
    );
  });
  return { received, server };
};

const toolCall = (name: string, args?: unknown, id = 1) => ({
  id,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: args ?? { iid: 7 }, name },
});

const config = (url: string): McpServer[] => [
  {
    allow: ["get_issue"],
    headers: { Authorization: "Bearer upstream-secret" },
    holdMs: 200,
    name: "gitlab",
    url,
  },
  { allow: [], headers: {}, holdMs: 200, name: "linear", url },
];

/** A tool call's result, as the agent reads it. */
const resultText = async (response: Response) => {
  const body = (await response.json()) as {
    result?: { content: { text: string }[]; isError?: boolean };
  };
  return {
    isError: body.result?.isError ?? false,
    text: body.result?.content[0]?.text ?? "",
  };
};

describe(createMcpProxy, () => {
  let approvals: Approvals;
  let audit: Audit;
  let base: string;
  let dir: string;
  let logged: string[];
  let proxyServer: Server;
  let received: Received[];
  let sandboxes: Map<string, string>;
  let store: McpStore;
  let tokenA: string;
  let up: Server;

  const post = async (
    body: unknown,
    {
      endpoint = "gitlab/feature-a",
      headers = {},
      token = tokenA,
    }: {
      endpoint?: string;
      headers?: Record<string, string>;
      token?: string | null;
    } = {}
  ) =>
    await fetch(`${base}/mcp/${endpoint}`, {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      method: "POST",
    });

  const statusOf = async (...args: Parameters<typeof post>) => {
    const response = await post(...args);
    return response.status;
  };

  /** A call from feature-a to the proxy at `url`. */
  const callAt = async (url: string, call: unknown) =>
    await fetch(`${url}/mcp/gitlab/feature-a`, {
      body: JSON.stringify(call),
      headers: { Authorization: `Bearer ${tokenA}` },
      method: "POST",
    });

  /** Waits for the proxy to queue a call. */
  const nextPending = async () => {
    for (let tries = 0; tries < 100; tries += 1) {
      const [pending] = approvals.pending();
      if (pending?.waiting) {
        return pending;
      }
      // oxlint-disable-next-line no-await-in-loop -- polling
      await sleep(5);
    }
    throw new Error("Nothing was queued");
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-proxy-"));
    ({ received, server: up } = upstream());
    const upstreamUrl = `${await listen(up)}/api/mcp`;
    store = createMcpStore(dir);
    audit = createAudit(dir);
    approvals = createApprovals();
    logged = [];
    sandboxes = new Map([
      [A.name, A.id],
      [B.name, B.id],
    ]);
    tokenA = await store.register("gitlab", A);
    const proxy = createMcpProxy({
      approvals,
      audit,
      findSandbox: (name) => {
        if (name === "broken") {
          return Promise.reject(new Error("sbx is down"));
        }
        const id = sandboxes.get(name);
        return Promise.resolve(id === undefined ? undefined : { id });
      },
      log: (message) => logged.push(message),
      servers: config(upstreamUrl),
      store,
    });
    proxyServer = createServer((req, res) => {
      proxy.handle(req, res, new URL(req.url ?? "/", "http://panel.test"));
    });
    base = await listen(proxyServer);
  });

  afterEach(async () => {
    proxyServer.closeAllConnections();
    proxyServer.close();
    up.closeAllConnections();
    up.close();
    await rm(dir, { force: true, recursive: true });
  });

  describe("identity", () => {
    it("refuses a missing or unknown token", async () => {
      const missing = await post(toolCall("get_issue"), { token: null });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");
      await expect(
        statusOf(toolCall("get_issue"), { token: "forged" })
      ).resolves.toBe(401);
      expect(received).toStrictEqual([]);
    });

    it("refuses a token on another sandbox's or another server's endpoint", async () => {
      await store.register("gitlab", B);
      for (const endpoint of ["gitlab/feature-b", "linear/feature-a"]) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        const response = await post(toolCall("get_issue"), { endpoint });
        expect(response.status).toBe(403);
      }
      expect(received).toStrictEqual([]);
      expect(logged.join("\n")).toContain("with the token of gitlab/feature-a");
    });

    it("refuses the token of a removed sandbox whose name was reused", async () => {
      sandboxes.set(A.name, "id-new");
      await expect(statusOf(toolCall("get_issue"))).resolves.toBe(403);
      sandboxes.delete(A.name);
      await expect(statusOf(toolCall("get_issue"))).resolves.toBe(403);
      expect(received).toStrictEqual([]);
    });

    it("refuses when it can't tell whether the sandbox still exists", async () => {
      const token = await store.register("gitlab", { id: "x", name: "broken" });
      const response = await post(toolCall("get_issue"), {
        endpoint: "gitlab/broken",
        token,
      });
      expect(response.status).toBe(503);
      expect(received).toStrictEqual([]);
    });

    it("names the token's sandbox, whatever the call claims", async () => {
      const call = post(toolCall("create_note", { sandbox: "feature-b" }));
      await expect(nextPending()).resolves.toMatchObject({
        sandbox: { id: "id-a", name: "feature-a" },
      });
      const pending = await nextPending();
      approvals.decide(pending.id, "denied");
      await call;
    });
  });

  describe("passing through", () => {
    it("passes an allowlisted call, and the server's answer back", async () => {
      const response = await post(toolCall("get_issue"), {
        headers: { "Mcp-Session-Id": "session-1" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("session-1");
      expect(response.headers.get("www-authenticate")).toBeNull();
      await expect(resultText(response)).resolves.toStrictEqual({
        isError: false,
        text: "upstream",
      });
    });

    it("sends the server's credentials, never the sandbox's", async () => {
      await post(toolCall("get_issue"), {
        headers: { "Mcp-Session-Id": "session-1" },
      });
      expect(received).toMatchObject([
        {
          body: toolCall("get_issue"),
          headers: {
            authorization: "Bearer upstream-secret",
            "mcp-session-id": "session-1",
          },
        },
      ]);
      await expect(audit.recent(1)).resolves.toMatchObject([
        {
          outcome: "allowed",
          sandbox: A,
          server: "gitlab",
          tool: "get_issue",
        },
      ]);
    });

    it("passes everything but tool calls, unaudited", async () => {
      const initialize = {
        id: 0,
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
      };
      await expect(statusOf(initialize)).resolves.toBe(200);
      const batch = [{ id: 1, jsonrpc: "2.0", method: "ping" }];
      await expect(statusOf(batch)).resolves.toBe(200);
      const stream = await fetch(`${base}/mcp/gitlab/feature-a`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(stream.status).toBe(200);
      expect(received.map(({ method }) => method)).toStrictEqual([
        "POST",
        "POST",
        "GET",
      ]);
      await expect(audit.recent(10)).resolves.toStrictEqual([]);
    });

    it("makes no call it couldn't record", async () => {
      const proxy = createMcpProxy({
        approvals,
        audit: {
          recent: () => Promise.resolve([]),
          record: () => Promise.reject(new Error("disk full")),
        },
        findSandbox: () => Promise.resolve({ id: A.id }),
        log: (message) => logged.push(message),
        servers: config(`${base}/unused`),
        store,
      });
      const server = createServer((req, res) => {
        proxy.handle(req, res, new URL(req.url ?? "/", "http://panel.test"));
      });
      const url = await listen(server);
      const response = await fetch(`${url}/mcp/gitlab/feature-a`, {
        body: JSON.stringify(toolCall("get_issue")),
        headers: { Authorization: `Bearer ${tokenA}` },
        method: "POST",
      });
      server.close();
      await expect(resultText(response)).resolves.toMatchObject({
        isError: true,
      });
      expect(received).toStrictEqual([]);
      expect(logged.join("\n")).toContain("disk full");
    });

    it("passes a tool always allowed", async () => {
      await store.allow("gitlab", "list_issues");
      await expect(
        resultText(await post(toolCall("list_issues")))
      ).resolves.toMatchObject({
        isError: false,
      });
    });

    it("tells the agent when the server can't be reached", async () => {
      up.closeAllConnections();
      up.close();
      await once(up, "close");
      const response = await post(toolCall("get_issue"));
      await expect(resultText(response)).resolves.toStrictEqual({
        isError: true,
        text: "Makak Panel could not reach the gitlab MCP server.",
      });
      await expect(audit.recent(1)).resolves.toMatchObject([
        { outcome: "allowed" },
      ]);
    });
  });

  describe("servers that sign in with OAuth", () => {
    const servers: Server[] = [];
    let signedOut: string[];

    beforeEach(() => {
      signedOut = [];
    });

    afterEach(() => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
      }
    });

    /** A proxy for one OAuth server, with the given tokens to hand out. */
    const oauthProxy = async (tokens: {
      current: string | undefined;
      refreshed: string | undefined;
      failing?: boolean;
    }) => {
      const url = up.address();
      const proxy = createMcpProxy({
        approvals,
        audit,
        findSandbox: () => Promise.resolve({ id: A.id }),
        log: (message) => logged.push(message),
        oauth: {
          accessToken: () =>
            tokens.failing
              ? Promise.reject(new Error("token endpoint down"))
              : Promise.resolve(tokens.current),
          refresh: () => {
            tokens.current = tokens.refreshed;
            return Promise.resolve(tokens.refreshed);
          },
          signOut: (name) => {
            signedOut.push(name);
            return Promise.resolve();
          },
        },
        servers: [
          {
            allow: ["get_issue"],
            headers: {},
            holdMs: 200,
            name: "gitlab",
            oauth: { scopes: [] },
            url: `http://127.0.0.1:${(url as AddressInfo).port}/api/mcp`,
          },
        ],
        store,
      });
      const server = createServer((req, res) => {
        proxy.handle(req, res, new URL(req.url ?? "/", "http://panel.test"));
      });
      servers.push(server);
      return await listen(server);
    };

    it("sends the Panel's token", async () => {
      const url = await oauthProxy({ current: "at-1", refreshed: undefined });
      await callAt(url, toolCall("get_issue"));
      expect(received[0]?.headers.authorization).toBe("Bearer at-1");
    });

    it("refreshes a token the server refuses, and tries once more", async () => {
      const url = await oauthProxy({ current: "stale", refreshed: "at-2" });
      const response = await callAt(url, toolCall("get_issue"));
      await expect(resultText(response)).resolves.toMatchObject({
        isError: false,
      });
      expect(
        received.map(({ headers }) => headers.authorization)
      ).toStrictEqual(["Bearer stale", "Bearer at-2"]);
    });

    it("tells the agent to have the user sign in, without asking the user about the call", async () => {
      const url = await oauthProxy({
        current: undefined,
        refreshed: undefined,
      });
      const response = await callAt(url, toolCall("create_note"));
      const { isError, text } = await resultText(response);
      expect(isError).toBeTruthy();
      expect(text).toContain("not signed in to the gitlab MCP server");
      expect(approvals.pending()).toStrictEqual([]);
      expect(received).toStrictEqual([]);
    });

    it("signs out when even a fresh token is refused", async () => {
      const url = await oauthProxy({ current: "stale", refreshed: "stale" });
      const { text } = await resultText(
        await callAt(url, toolCall("get_issue"))
      );
      expect(text).toContain("not signed in to the gitlab MCP server");
      expect(signedOut).toStrictEqual(["gitlab"]);
    });

    it("answers with a tool error when signing in fails for now", async () => {
      const url = await oauthProxy({
        current: "at-1",
        failing: true,
        refreshed: undefined,
      });
      const response = await callAt(url, toolCall("create_note"));
      expect(response.status).toBe(200);
      await expect(resultText(response)).resolves.toMatchObject({
        isError: true,
        text: expect.stringContaining("could not sign in"),
      });
      expect(approvals.pending()).toStrictEqual([]);
    });

    it("answers other requests with an error while signed out", async () => {
      const url = await oauthProxy({ current: "stale", refreshed: undefined });
      const response = await callAt(url, {
        id: 0,
        jsonrpc: "2.0",
        method: "tools/list",
      });
      expect(response.status).toBe(503);
    });
  });

  describe("holding", () => {
    it("holds a call off the allowlist until it is approved", async () => {
      const response = post(toolCall("create_note"));
      const pending = await nextPending();
      expect(pending).toMatchObject({
        arguments: { iid: 7 },
        server: "gitlab",
        tool: "create_note",
      });
      expect(received).toStrictEqual([]);

      approvals.decide(pending.id, "approved");
      await expect(resultText(await response)).resolves.toMatchObject({
        isError: false,
      });
      expect(received).toHaveLength(1);
      await expect(audit.recent(1)).resolves.toMatchObject([
        { outcome: "approved", request: pending.id },
      ]);
    });

    it("answers a denied call itself", async () => {
      const response = post(toolCall("create_note"));
      const pending = await nextPending();
      approvals.decide(pending.id, "denied");
      await expect(resultText(await response)).resolves.toStrictEqual({
        isError: true,
        text: "The user denied this call to create_note in Makak Panel.",
      });
      expect(received).toStrictEqual([]);
      await expect(audit.recent(1)).resolves.toMatchObject([
        { outcome: "denied" },
      ]);
    });

    it("tells the agent to ask again when nobody decides in time", async () => {
      const held = await resultText(await post(toolCall("create_note")));
      const [pending] = approvals.pending();
      expect(held.isError).toBeTruthy();
      expect(held.text).toContain(`as request ${pending?.id}`);
      await expect(audit.recent(1)).resolves.toMatchObject([
        { outcome: "held" },
      ]);
    });

    it("lets the retry through once approved", async () => {
      await post(toolCall("create_note"));
      const [pending] = approvals.pending();
      approvals.decide(pending?.id ?? "", "approved");
      const retry = await resultText(
        await post(toolCall("create_note", { iid: 7 }, 2))
      );
      expect(retry).toMatchObject({ isError: false });
      expect(received).toHaveLength(1);
      await expect(audit.recent(1)).resolves.toMatchObject([
        { earlier: true, outcome: "approved", request: pending?.id },
      ]);
    });

    it("checks the call the server gets, not bytes another parser might read otherwise", async () => {
      const body =
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_issue","name":"create_note","arguments":{}}}';
      const response = post(body);
      const pending = await nextPending();
      expect(pending.tool).toBe("create_note");
      approvals.decide(pending.id, "approved");
      await response;
      expect(received[0]?.body).toStrictEqual({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "create_note" },
      });
    });

    it("refuses tool calls in a batch", async () => {
      const response = await post([toolCall("get_issue")]);
      expect(response.status).toBe(400);
      expect(received).toStrictEqual([]);
    });
  });

  it("refuses unknown servers, other methods and bodies that aren't JSON", async () => {
    await expect(
      statusOf(toolCall("get_issue"), { endpoint: "jira/feature-a" })
    ).resolves.toBe(404);
    await expect(
      statusOf(toolCall("get_issue"), { endpoint: "gitlab" })
    ).resolves.toBe(404);
    await expect(statusOf("{nope")).resolves.toBe(400);
    const put = await fetch(`${base}/mcp/gitlab/feature-a`, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(received).toStrictEqual([]);
  });
});

describe("the endpoints' prefix", () => {
  it("is left to the endpoints, so no page's data is sent to them", () => {
    const routes = new URL(`../../routes${MCP_PATH}`, import.meta.url);
    expect(existsSync(routes)).toBeFalsy();
  });
});
