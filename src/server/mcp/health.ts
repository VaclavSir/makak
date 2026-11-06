import type { McpServer } from "./proxy.ts";
import { failureOf, SignedOutError } from "./upstream.ts";
import type { Upstream } from "./upstream.ts";

// What the Panel knows about each wrapped server's health: the last check,
// in which the Panel initializes a session with the server and lists its
// tools, with its own credentials, and the last error the server gave a real
// request. Kept in memory: the servers are checked again at every start.

/** A tool as the server lists it. */
export interface McpTool {
  description: string | undefined;
  name: string;
  /** The server says the tool changes nothing. A hint, never a permission. */
  readOnly: boolean;
}

export type CheckResult =
  | { at: string; ok: true; tools: McpTool[] }
  | { at: string; ok: false; reason: string };

export interface ServerError {
  at: string;
  message: string;
}

export interface ServerHealth {
  check: CheckResult | undefined;
  lastError: ServerError | undefined;
}

export interface McpHealth {
  /** Checks the server now; a check already running is joined. */
  check: (server: string) => Promise<CheckResult>;
  /** Records an error the server gave, or reaching it failed with. */
  noteError: (server: string, message: string) => void;
  status: (server: string) => ServerHealth;
  /** The server's last error, if there was one since `since`. */
  errorSince: (server: string, since: number) => ServerError | undefined;
}

export interface McpHealthOptions {
  now?: () => number;
  servers: readonly McpServer[];
  /** How long a check may take, in all. */
  timeoutMs?: number;
  upstream: Upstream;
}

const CHECK_TIMEOUT_MS = 15_000;
const MAX_REASON = 300;
const MAX_PAGES = 20;

/** The Panel as a client, in `initialize`. */
const CLIENT = { name: "makak-panel", version: "1" };
const PROTOCOL_VERSION = "2025-06-18";

/** The text in a JSON-RPC error's `data`, which often says more than its message. */
const detailOf = (data: unknown): string[] => {
  if (typeof data === "string") {
    return [data];
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return Object.values(data).filter(
      (value): value is string => typeof value === "string"
    );
  }
  return [];
};

/** What a server's error answer says, from the usual JSON fields if any. */
export const reasonOf = (body: string): string => {
  let reason = body.trim();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const rpc = parsed.error as Record<string, unknown> | undefined;
    const field = [
      parsed.error_description,
      parsed.message,
      rpc?.message,
      parsed.error,
    ].find((value) => typeof value === "string" && value !== "");
    if (typeof field === "string") {
      reason = [field, ...detailOf(rpc?.data)].join(": ");
    }
  } catch {
    // Not JSON: the text as it is.
  }
  return reason.slice(0, MAX_REASON) || "no reason given";
};

/**
 * The JSON-RPC message answering `id` in a response body, which is either
 * the JSON itself or a stream of server-sent events carrying it.
 */
export const messageFor = (
  body: string,
  contentType: string | null,
  id: unknown
): Record<string, unknown> | undefined => {
  const texts = contentType?.startsWith("text/event-stream")
    ? body.split(/\r?\n\r?\n/u).map((event) =>
        event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n")
      )
    : [body];
  for (const text of texts) {
    try {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.id === id) {
        return message;
      }
    } catch {
      // Not a message: a comment, or an event of another kind.
    }
  }
  return undefined;
};

/** A check that failed, with the reason to show. */
class CheckFailureError extends Error {
  override name = "CheckFailureError";
}

const toolsOf = (result: unknown): { cursor?: string; tools: McpTool[] } => {
  const { nextCursor, tools } = (result ?? {}) as {
    nextCursor?: unknown;
    tools?: unknown;
  };
  if (!Array.isArray(tools)) {
    throw new CheckFailureError("The server's tool list isn't one.");
  }
  return {
    cursor: typeof nextCursor === "string" ? nextCursor : undefined,
    tools: tools.flatMap((tool: unknown) => {
      const { annotations, description, name } = (tool ?? {}) as Record<
        string,
        unknown
      >;
      return typeof name === "string"
        ? [
            {
              description:
                typeof description === "string" ? description : undefined,
              name,
              readOnly:
                (annotations as Record<string, unknown> | undefined)
                  ?.readOnlyHint === true,
            },
          ]
        : [];
    }),
  };
};

export const createMcpHealth = ({
  now = Date.now,
  servers,
  timeoutMs = CHECK_TIMEOUT_MS,
  upstream,
}: McpHealthOptions): McpHealth => {
  const checks = new Map<string, CheckResult>();
  const errors = new Map<string, ServerError>();
  const running = new Map<string, Promise<CheckResult>>();
  const stamp = () => new Date(now()).toISOString();

  /** One session: initialize, list every page of tools, end it. */
  const probe = async (server: McpServer): Promise<McpTool[]> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    let nextId = 1;
    const send = async (method: string, params?: unknown) => {
      const id = method.startsWith("notifications/") ? undefined : nextId;
      nextId += 1;
      const response = await upstream(server, {
        body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
        headers: { ...headers },
        method: "POST",
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new CheckFailureError(
          `HTTP ${response.status}: ${reasonOf(text)}`
        );
      }
      const session = response.headers.get("mcp-session-id");
      if (session !== null) {
        headers["mcp-session-id"] = session;
      }
      if (id === undefined) {
        return;
      }
      const message = messageFor(
        text,
        response.headers.get("content-type"),
        id
      );
      if (message === undefined) {
        throw new CheckFailureError(`The server didn't answer ${method}.`);
      }
      if (message.error !== undefined) {
        throw new CheckFailureError(
          `The server refused ${method}: ${reasonOf(JSON.stringify(message))}`
        );
      }
      return message.result;
    };

    const init = (await send("initialize", {
      capabilities: {},
      clientInfo: CLIENT,
      protocolVersion: PROTOCOL_VERSION,
    })) as { protocolVersion?: unknown } | undefined;
    if (typeof init?.protocolVersion === "string") {
      headers["mcp-protocol-version"] = init.protocolVersion;
    }
    await send("notifications/initialized");
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const listed = toolsOf(await send("tools/list", cursor && { cursor }));
      tools.push(...listed.tools);
      ({ cursor } = listed);
      if (cursor === undefined) {
        break;
      }
    }
    if (headers["mcp-session-id"] !== undefined) {
      // Ending the session is a courtesy; a server may not support it.
      try {
        const response = await upstream(server, {
          headers,
          method: "DELETE",
          signal,
        });
        await response.body?.cancel();
      } catch {
        // The tools are listed either way.
      }
    }
    return tools;
  };

  const run = async (server: McpServer): Promise<CheckResult> => {
    try {
      const tools = await probe(server);
      return { at: stamp(), ok: true, tools };
    } catch (error) {
      let reason: string;
      if (error instanceof CheckFailureError) {
        ({ message: reason } = error);
      } else if (error instanceof SignedOutError) {
        reason = "The Panel isn't signed in to it.";
      } else if ((error as Error).name === "TimeoutError") {
        reason = `It didn't answer within ${timeoutMs / 1000} seconds.`;
      } else {
        reason = `It can't be reached: ${failureOf(error)}`;
      }
      return { at: stamp(), ok: false, reason };
    }
  };

  return {
    check: async (name) => {
      const server = servers.find((each) => each.name === name);
      if (server === undefined) {
        throw new Error(`There is no MCP server named ${name}`);
      }
      const joined = running.get(name);
      if (joined !== undefined) {
        return await joined;
      }
      const result = run(server);
      running.set(name, result);
      try {
        const done = await result;
        checks.set(name, done);
        return done;
      } finally {
        running.delete(name);
      }
    },

    errorSince: (server, since) => {
      const error = errors.get(server);
      return error !== undefined && Date.parse(error.at) >= since
        ? error
        : undefined;
    },

    noteError: (server, message) => {
      errors.set(server, { at: stamp(), message });
    },

    status: (server) => ({
      check: checks.get(server),
      lastError: errors.get(server),
    }),
  };
};
