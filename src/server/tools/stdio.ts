import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Local MCP servers: commands the Panel runs on the host and talks to over
// stdin and stdout, one JSON message per line, as MCP's stdio transport
// does. The only processes the Panel owns: it stops them when it exits.

/** What to run. */
export interface StdioCommand {
  args: readonly string[];
  command: string;
  cwd: string | undefined;
  /** On top of the few variables every process gets; see `BASE_ENV`. */
  env: Record<string, string>;
}

export interface StdioHandlers {
  /** A line the process wrote to stdout. */
  onLine: (line: string) => void;
  /** Text the process wrote to stderr. */
  onStderr: (text: string) => void;
}

export interface StdioProcess {
  /** Writes one line to the process's stdin. */
  send: (line: string) => void;
  kill: () => void;
  /** How it ended: its exit code, or why it couldn't run at all. */
  exited: Promise<string>;
}

export type SpawnStdio = (
  command: StdioCommand,
  handlers: StdioHandlers
) => StdioProcess;

/**
 * Passed on from the Panel's environment, and nothing else of it, so a
 * server never sees the variables that hold another server's credentials.
 */
export const BASE_ENV = [
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TZ",
  "USER",
];

/** The environment a local server runs with. */
export const stdioEnv = (
  env: Record<string, string>,
  from: NodeJS.ProcessEnv = process.env
): Record<string, string> => ({
  ...Object.fromEntries(
    BASE_ENV.flatMap((name) => {
      const value = from[name];
      return value === undefined ? [] : [[name, value]];
    })
  ),
  ...env,
});

export const spawnStdio: SpawnStdio = (
  { args, command, cwd, env },
  { onLine, onStderr }
) => {
  const child = spawn(command, args, {
    cwd,
    env: stdioEnv(env),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = Promise.withResolvers<string>();
  child.on("error", (error: NodeJS.ErrnoException) => {
    exited.resolve(
      error.code === "ENOENT"
        ? `${command} is not installed or not on PATH`
        : error.message
    );
  });
  child.on("exit", (code, signal) => {
    exited.resolve(
      signal === null ? `exited with code ${code}` : `stopped by ${signal}`
    );
  });
  createInterface({ input: child.stdout }).on("line", onLine);
  child.stderr.setEncoding("utf-8").on("data", onStderr);
  // A process that exits while being written to must not crash the Panel.
  child.stdin.on("error", () => {
    // How it ended is in `exited`.
  });
  return {
    exited: exited.promise,
    kill: () => {
      child.kill();
    },
    send: (line) => {
      child.stdin.write(`${line}\n`);
    },
  };
};

/**
 * A stand-in local server, answering like a small MCP server with one tool,
 * `echo`, which returns its arguments.
 */
export const createFakeStdio =
  (): SpawnStdio =>
  (command, { onLine }) => {
    const done = Promise.withResolvers<string>();
    let running = true;
    const answer = (id: unknown, result: unknown) => {
      // Asynchronously, as a process would.
      queueMicrotask(() => {
        if (running) {
          onLine(JSON.stringify({ id, jsonrpc: "2.0", result }));
        }
      });
    };
    return {
      exited: done.promise,
      kill: () => {
        running = false;
        done.resolve("stopped by SIGTERM");
      },
      send: (line) => {
        const { id, method, params } = JSON.parse(line) as {
          id?: unknown;
          method?: string;
          params?: { arguments?: unknown };
        };
        if (id === undefined || method === undefined) {
          return;
        }
        if (method === "initialize") {
          answer(id, {
            capabilities: { tools: {} },
            protocolVersion: "2025-06-18",
            serverInfo: { name: `(fake) ${command.command}`, version: "0" },
          });
        } else if (method === "tools/list") {
          answer(id, {
            tools: [
              {
                annotations: { readOnlyHint: true },
                description: "Returns its arguments.",
                inputSchema: { type: "object" },
                name: "echo",
              },
            ],
          });
        } else if (method === "tools/call") {
          answer(id, {
            content: [
              { text: JSON.stringify(params?.arguments), type: "text" },
            ],
          });
        } else {
          answer(id, {});
        }
      },
    };
  };
