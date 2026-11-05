import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

import type { StdioCommand } from "../tools/stdio.ts";
import type { Approvals, Outcome } from "./approvals.ts";
import type { Audit, AuditEntry } from "./audit.ts";
import { reasonOf } from "./health.ts";
import type { McpHealth } from "./health.ts";
import type { OAuth } from "./oauth.ts";
import type { McpStore } from "./store.ts";
import { createUpstream, failureOf, SignedOutError } from "./upstream.ts";
import type { Upstream } from "./upstream.ts";

// The MCP approval proxy: one endpoint per server, at `/mcp/<server>`, shared
// by every sandbox the server is loaded into, passing everything through to
// the server except tool calls off the allowlist, which wait for the user.
// The sbx MCP gateway passes on no sandbox identity, so the proxy has none:
// its bearer token says only which server's registration is calling.

/** Reserved for the endpoints: no page of the Panel may live under it. */
export const MCP_PATH = "/mcp/";

/**
 * A wrapped server, with its upstream headers and its environment resolved:
 * a remote one, at `url`, or a local one, which the Panel runs itself.
 */
export interface McpServer {
  allow: readonly string[];
  /** Remote servers only. */
  headers: Record<string, string>;
  holdMs: number;
  /** Local servers only: the command, run on the host. */
  local?: StdioCommand;
  name: string;
  /** Remote servers only. Signs in with OAuth: the Panel's token goes with every call. */
  oauth?: { scopes: readonly string[] };
  /** Remote servers only. */
  url?: string;
}

export interface McpProxyOptions {
  approvals: Approvals;
  audit: Audit;
  /** Told of every error a server gives, for the approvals page. */
  health?: Pick<McpHealth, "noteError">;
  log: (message: string) => void;
  oauth?: Pick<OAuth, "accessToken" | "refresh" | "signOut">;
  servers: readonly McpServer[];
  store: Pick<McpStore, "allowed" | "identify">;
  fetch?: typeof fetch;
  /** How requests reach the servers; by default with `fetch` and `oauth`. */
  upstream?: Upstream;
  now?: () => number;
}

export interface McpProxy {
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** How much of a server's error answer is logged. */
const MAX_LOGGED_BODY = 500;

// What passes between the gateway and the server. Not the gateway's
// Authorization: that is the registration's token, for the Panel only.
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
// Not WWW-Authenticate: the server's auth is the Panel's business, and the
// gateway would try to sign in to it.
const RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
];

interface Message {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isToolCall = (message: unknown) =>
  isRecord(message) && message.method === "tools/call" && "id" in message;

/** What a request asked, to say which one a server refused. */
const askedIn = (method: string | undefined, message?: unknown) => {
  if (method !== "POST") {
    return method ?? "GET";
  }
  const methods = (Array.isArray(message) ? message : [message]).map(
    (each: unknown) =>
      isRecord(each) && typeof each.method === "string"
        ? each.method
        : "a response"
  );
  return methods.join(", ");
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendError = (res: ServerResponse, status: number, message: string) => {
  sendJson(res, status, {
    error: { code: -32_600, message },
    id: null,
    jsonrpc: "2.0",
  });
};

/** A tool result the agent reads as an error, rather than a protocol error. */
const sendToolError = (res: ServerResponse, id: unknown, text: string) => {
  sendJson(res, 200, {
    id,
    jsonrpc: "2.0",
    result: { content: [{ text, type: "text" }], isError: true },
  });
};

const signedOutText = (server: string) =>
  `Makak Panel is not signed in to the ${server} MCP server. Ask the user to sign in on the Panel's MCP approvals page, then try again.`;

/** The body, or undefined when it is too large. */
const readBody = async (req: IncomingMessage): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
};

/** `/mcp/<server>`, decoded, or undefined for any other path. */
const serverOf = (pathname: string) => {
  const part = pathname.slice(MCP_PATH.length);
  if (part === "" || part.includes("/")) {
    return;
  }
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed escape: no server has that name.
  }
};

const bearerOf = (header: string | undefined) => {
  const match = /^Bearer (?<token>\S+)$/u.exec(header ?? "");
  return match?.groups?.token;
};

const heldText = (tool: string, id: string) =>
  `This call to ${tool} needs the user's approval in Makak Panel, where it is waiting as request ${id}. The user has not decided yet. To wait for the decision, make the same call again with exactly the same arguments: it goes through as soon as the user approves it. Don't try to get the same effect another way.`;

const deniedText = (tool: string) =>
  `The user denied this call to ${tool} in Makak Panel.`;

export const createMcpProxy = ({
  approvals,
  audit,
  fetch: fetchUpstream = fetch,
  health,
  log,
  now = Date.now,
  oauth,
  servers,
  store,
  upstream: given,
}: McpProxyOptions): McpProxy => {
  const byName = new Map(servers.map((server) => [server.name, server]));
  const upstream = given ?? createUpstream({ fetch: fetchUpstream, oauth });

  /** Logs a server's error, and keeps it for the approvals page. */
  const failed = (server: string, message: string) => {
    log(`${server}: ${message}`);
    health?.noteError(server, message);
  };

  /** False when the entry couldn't be written. */
  const record = async (entry: AuditEntry) => {
    try {
      await audit.record(entry);
      return true;
    } catch (error) {
      log(`Could not write the MCP audit log: ${(error as Error).message}`);
      return false;
    }
  };

  /** Whether the token is the server's; if not, the refusal is sent. */
  const authorized = async (
    req: IncomingMessage,
    res: ServerResponse,
    server: string
  ) => {
    const token = bearerOf(req.headers.authorization);
    const owner = token === undefined ? undefined : await store.identify(token);
    if (owner === undefined) {
      log(
        `Refused MCP request to ${server}: ${token === undefined ? "no" : "unknown"} token`
      );
      res.setHeader("WWW-Authenticate", "Bearer");
      sendError(res, 401, "Missing or unknown token");
      return false;
    }
    if (owner !== server) {
      log(`Refused MCP request to ${server} with the token of ${owner}`);
      sendError(res, 403, "This token is for another server");
      return false;
    }
    return true;
  };

  /** Passes the request on, and the response back. */
  const forward = async (
    req: IncomingMessage,
    res: ServerResponse,
    server: McpServer,
    body: string | undefined,
    signal: AbortSignal,
    asked = askedIn(req.method)
  ): Promise<void> => {
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
    const response = await upstream(server, {
      body,
      headers,
      method: req.method ?? "GET",
      signal,
    });
    const passed: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) {
        passed[name] = value;
      }
    }
    if (!response.ok) {
      // Small, and the only clue to why the server refused: logged, then
      // passed back as it came.
      const text = await response.text();
      log(
        `${server.name} answered ${asked} with HTTP ${response.status}: ${text.slice(0, MAX_LOGGED_BODY).trim() || "(no body)"}`
      );
      health?.noteError(
        server.name,
        `HTTP ${response.status} to ${asked}: ${reasonOf(text)}`
      );
      res.writeHead(response.status, passed);
      res.end(text);
      return;
    }
    res.writeHead(response.status, passed);
    if (response.body === null) {
      res.end();
    } else {
      Readable.fromWeb(response.body as ReadableStream).pipe(res);
    }
  };

  /** Why calls to the server can't be made now, if they can't. */
  const signInProblemOf = async (server: McpServer) => {
    if (server.oauth === undefined) {
      return;
    }
    try {
      const token = await oauth?.accessToken(server.name);
      return token === undefined ? signedOutText(server.name) : undefined;
    } catch (error) {
      log(`Signing in to ${server.name} failed: ${(error as Error).message}`);
      return `Makak Panel could not sign in to the ${server.name} MCP server just now. Try again later.`;
    }
  };

  /** A tool call: let through, or held until the user decides. */
  const call = async (
    req: IncomingMessage,
    res: ServerResponse,
    context: {
      body: string;
      message: Message;
      server: McpServer;
      signal: AbortSignal;
    }
  ) => {
    const { body, message, server, signal } = context;
    const params = isRecord(message.params) ? message.params : {};
    const tool = params.name;
    if (typeof tool !== "string") {
      sendError(res, 400, "tools/call needs a tool name");
      return;
    }
    const started = now();
    const base = {
      arguments: params.arguments,
      at: new Date(started).toISOString(),
      server: server.name,
      tool,
    };

    // Not worth asking the user about a call that can't be made.
    const signInProblem = await signInProblemOf(server);
    if (signInProblem !== undefined) {
      sendToolError(res, message.id, signInProblem);
      return;
    }

    let outcome: Outcome | "allowed";
    let request: string | undefined;
    let earlier = false;
    const always = await store.allowed(server.name);
    if (server.allow.includes(tool) || always.includes(tool)) {
      outcome = "allowed";
    } else {
      const answer = await approvals.ask(
        {
          arguments: params.arguments,
          server: server.name,
          tool,
        },
        { holdMs: server.holdMs, signal }
      );
      ({ earlier, outcome } = answer);
      request = answer.id;
    }

    // Recorded before the server sees the call, so nothing reaches it unlogged.
    const recorded = await record({
      ...base,
      earlier,
      ms: now() - started,
      outcome,
      request,
    });
    if (!recorded && (outcome === "allowed" || outcome === "approved")) {
      sendToolError(
        res,
        message.id,
        "Makak Panel could not record this call in its audit log, so it was not made."
      );
    } else if (outcome === "allowed" || outcome === "approved") {
      try {
        await forward(req, res, server, body, signal, "tools/call");
      } catch (error) {
        if (signal.aborted || res.headersSent) {
          throw error;
        }
        if (error instanceof SignedOutError) {
          sendToolError(res, message.id, signedOutText(server.name));
          return;
        }
        failed(server.name, `Can't be reached: ${failureOf(error)}`);
        sendToolError(
          res,
          message.id,
          `Makak Panel could not reach the ${server.name} MCP server.`
        );
      }
    } else if (outcome === "denied") {
      sendToolError(res, message.id, deniedText(tool));
    } else if (outcome === "held") {
      sendToolError(res, message.id, heldText(tool, request ?? ""));
    }
  };

  const post = async (
    req: IncomingMessage,
    res: ServerResponse,
    server: McpServer,
    signal: AbortSignal
  ) => {
    const text = await readBody(req);
    if (text === undefined) {
      sendError(res, 413, "Request too large");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      sendError(res, 400, "Not JSON");
      return;
    }
    // What was checked is what the server gets: the parsed message, not the
    // bytes, which another parser might read differently.
    const body = JSON.stringify(message);
    if (Array.isArray(message)) {
      if (message.some(isToolCall)) {
        sendError(res, 400, "Tool calls can't be batched");
        return;
      }
    } else if (isToolCall(message)) {
      await call(req, res, {
        body,
        message: message as Message,
        server,
        signal,
      });
      return;
    }
    await forward(req, res, server, body, signal, askedIn("POST", message));
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ) => {
    const name = serverOf(url.pathname);
    const server = name === undefined ? undefined : byName.get(name);
    if (server === undefined) {
      sendError(res, 404, "No such MCP server");
      return;
    }
    if (!["DELETE", "GET", "POST"].includes(req.method ?? "")) {
      res.setHeader("Allow", "GET, POST, DELETE");
      sendError(res, 405, "Method not allowed");
      return;
    }
    // Ends a held call, or the server's stream, when the caller hangs up.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      if (!(await authorized(req, res, server.name))) {
        return;
      }
      await (req.method === "POST"
        ? post(req, res, server, controller.signal)
        : forward(req, res, server, undefined, controller.signal));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      if (error instanceof SignedOutError && !res.headersSent) {
        sendError(res, 503, signedOutText(server.name));
        return;
      }
      failed(server.name, `Can't be reached: ${failureOf(error)}`);
      if (res.headersSent) {
        res.destroy();
      } else {
        sendError(res, 502, `The ${server.name} MCP server can't be reached`);
      }
    }
  };

  return {
    handle: (req, res, url) => {
      void handle(req, res, url);
    },
  };
};
