import { randomUUID } from "node:crypto";

import type { SpawnStdio, StdioProcess } from "../tools/stdio.ts";
import type { McpServer } from "./proxy.ts";
import type { UpstreamRequest } from "./upstream.ts";

// Local MCP servers, which the Panel runs itself and serves at the same kind
// of endpoint as a remote one. This answers the proxy's requests the way a
// Streamable HTTP server would, and passes the messages to the process over
// stdio. Each session gets its own process, since a stdio server keeps state
// for one client: `initialize` starts one, and `DELETE` stops it. The sbx
// gateway keeps one session per sandbox, so that is a process per sandbox.

export interface LocalStatus {
  /** How many processes run for the server now. */
  processes: number;
  /** The end of what its processes wrote to stderr, and how they ended. */
  stderr: string[];
}

export interface LocalServers {
  /** Answers a request to a local server, as its endpoint would. */
  request: (server: McpServer, request: UpstreamRequest) => Promise<Response>;
  status: (server: string) => LocalStatus;
  /** Stops every process, when the Panel exits. */
  stopAll: () => void;
}

/** How many lines of stderr are kept per server. */
const STDERR_LINES = 50;

interface Message {
  error?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
}

interface Session {
  child: StdioProcess;
  /** Set once the process ended, with how. */
  ended: string | undefined;
  /** Requests waiting for their answer, by id. */
  pending: Map<string, (message: Message | Error) => void>;
  server: string;
  /** The open `GET` stream, which gets the server's own requests and notifications. */
  stream: ReadableStreamDefaultController<string> | undefined;
}

const keyOf = (id: unknown) => JSON.stringify(id);

const isRequest = (message: Message) =>
  typeof message.method === "string" && message.id !== undefined;

const isResponse = (message: Message) =>
  message.method === undefined &&
  message.id !== undefined &&
  ("result" in message || "error" in message);

const json = (status: number, body: unknown, headers = {}) =>
  Response.json(body, { headers, status });

/** A JSON-RPC error, as the gateway reads one. */
const rpcError = (status: number, message: string) =>
  json(status, { error: { code: -32_000, message }, id: null, jsonrpc: "2.0" });

export const createLocalServers = ({
  newSessionId = randomUUID,
  spawn,
}: {
  newSessionId?: () => string;
  spawn: SpawnStdio;
}): LocalServers => {
  const sessions = new Map<string, Session>();
  const stderr = new Map<string, string[]>();

  const note = (server: string, text: string) => {
    const lines = stderr.get(server) ?? [];
    lines.push(...text.split("\n").filter((line) => line.trim() !== ""));
    stderr.set(server, lines.slice(-STDERR_LINES));
  };

  /** Starts the server's process for a new session. */
  const start = (
    server: McpServer,
    command: NonNullable<McpServer["local"]>
  ) => {
    const id = newSessionId();
    // Everything but the process, which its handlers need.
    const state: Omit<Session, "child"> = {
      ended: undefined,
      pending: new Map(),
      server: server.name,
      stream: undefined,
    };
    const onLine = (line: string) => {
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        // Some servers log to stdout; kept with the rest of their output.
        note(server.name, line);
        return;
      }
      if (isResponse(message)) {
        state.pending.get(keyOf(message.id))?.(message);
        return;
      }
      // The server's own requests and notifications, for the client.
      state.stream?.enqueue(`event: message\ndata: ${line}\n\n`);
    };
    const session: Session = Object.assign(state, {
      child: spawn(command, {
        onLine,
        onStderr: (text: string) => {
          note(server.name, text);
        },
      }),
    });
    const ending = async () => {
      const how = await session.child.exited;
      session.ended = how;
      note(server.name, `(${how})`);
      sessions.delete(id);
      for (const answer of session.pending.values()) {
        answer(new Error(how));
      }
      session.pending.clear();
      try {
        session.stream?.close();
      } catch {
        // Closed by the client already.
      }
    };
    void ending();
    sessions.set(id, session);
    return { id, session };
  };

  /** Sends the messages, and waits for the answers to the requests among them. */
  const exchange = async (
    session: Session,
    messages: Message[],
    signal: AbortSignal | undefined
  ): Promise<Message[]> => {
    const answers = messages.filter(isRequest).map((message) => {
      const answered = Promise.withResolvers<Message>();
      session.pending.set(keyOf(message.id), (answer) => {
        session.pending.delete(keyOf(message.id));
        if (answer instanceof Error) {
          answered.reject(answer);
        } else {
          answered.resolve(answer);
        }
      });
      return answered.promise;
    });
    for (const message of messages) {
      session.child.send(JSON.stringify(message));
    }
    const all = Promise.all(answers);
    if (signal === undefined) {
      return await all;
    }
    // The caller hung up: stop waiting. The process carries on.
    const gone = Promise.withResolvers<never>();
    const abort = () => {
      gone.reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([all, gone.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };

  const post = async (
    server: McpServer,
    command: NonNullable<McpServer["local"]>,
    { body, headers, signal }: UpstreamRequest
  ) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? "");
    } catch {
      return rpcError(400, "Not JSON");
    }
    const batch = Array.isArray(parsed);
    const messages = (batch ? parsed : [parsed]) as Message[];
    const sessionId = headers["mcp-session-id"];
    let id: string;
    let session: Session | undefined;
    if (
      sessionId === undefined &&
      !batch &&
      messages[0]?.method === "initialize"
    ) {
      ({ id, session } = start(server, command));
    } else {
      id = sessionId ?? "";
      session = sessions.get(id);
      if (session === undefined || session.server !== server.name) {
        // As the transport says: the client starts a new session.
        return rpcError(404, "No such session. Initialize a new one.");
      }
    }
    const started = session;
    let answers: Message[];
    try {
      answers = await exchange(started, messages, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      return rpcError(
        502,
        `The local ${server.name} server ended before answering (${(error as Error).message}). Its output is on the MCP servers page.`
      );
    }
    const sessionHeader = { "mcp-session-id": id };
    if (!messages.some(isRequest)) {
      return new Response(null, { headers: sessionHeader, status: 202 });
    }
    return json(200, batch ? answers : answers[0], sessionHeader);
  };

  /** The stream of the server's own messages, for the session's client. */
  const listen = (session: Session, signal: AbortSignal | undefined) => {
    const body = new ReadableStream<string>({
      cancel: () => {
        session.stream = undefined;
      },
      start: (controller) => {
        session.stream = controller;
        signal?.addEventListener("abort", () => {
          session.stream = undefined;
          try {
            controller.close();
          } catch {
            // Closed when the process ended.
          }
        });
      },
    });
    return new Response(body.pipeThrough(new TextEncoderStream()), {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      },
    });
  };

  return {
    request: async (server, request) => {
      const command = server.local;
      if (command === undefined) {
        throw new Error(`${server.name} is not a local server`);
      }
      if (request.method === "POST") {
        return await post(server, command, request);
      }
      const session = sessions.get(request.headers["mcp-session-id"] ?? "");
      if (session === undefined || session.server !== server.name) {
        return rpcError(404, "No such session. Initialize a new one.");
      }
      if (request.method === "DELETE") {
        session.child.kill();
        return new Response(null, { status: 200 });
      }
      return listen(session, request.signal);
    },

    status: (server) => ({
      processes: [...sessions.values()].filter(
        (session) => session.server === server
      ).length,
      stderr: stderr.get(server) ?? [],
    }),

    stopAll: () => {
      for (const session of sessions.values()) {
        session.child.kill();
      }
    },
  };
};
