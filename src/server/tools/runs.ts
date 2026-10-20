import { readFileSync } from "node:fs";

import { RUN_COLUMNS, RUN_ID, RUN_ROWS } from "../../lib/runs.ts";
import { CommandError } from "./exec.ts";
import type { CommandResult } from "./exec.ts";

// Runs: commands started in a sandbox, detached, by run-helper.sh. The helper
// keeps everything in the sandbox, so the Panel owns no process and loses
// nothing when it restarts.

/** The helper, passed to `sh -c` on every call. */
export const RUN_HELPER = readFileSync(
  new URL("run-helper.sh", import.meta.url),
  "utf-8"
);

export interface Run {
  /** The bash script it runs, as typed. */
  command: string;
  /** The directory it runs in. */
  cwd: string;
  /** Set once it exited. */
  exitCode: number | undefined;
  id: string;
  logSize: number;
  startedAt: string;
  /**
   * `stopped` when stopped from the Panel; `lost` when it ended without an
   * exit code, e.g. with its sandbox.
   */
  state: "exited" | "lost" | "running" | "stopped";
}

export interface PackageScripts {
  /** `npm`, `pnpm`, `yarn` or `bun`, from the lockfile. */
  manager: string;
  scripts: Record<string, string>;
}

export interface Runs {
  start: (
    sandbox: string,
    run: { command: string; cwd: string; id: string }
  ) => Promise<void>;
  /** Oldest first. */
  list: (sandbox: string) => Promise<Run[]>;
  /** Stops the run and everything it started; resolves once it has. */
  stop: (sandbox: string, id: string) => Promise<void>;
  /**
   * The log from a byte offset. With `follow`, the stream stays open until
   * the run ends. Aborting `signal` ends it.
   */
  log: (
    sandbox: string,
    id: string,
    options: { follow: boolean; offset: number; signal?: AbortSignal }
  ) => ReadableStream<Uint8Array>;
  /** The scripts in `cwd`'s package.json; undefined without one. */
  packageScripts: (
    sandbox: string,
    cwd: string
  ) => Promise<PackageScripts | undefined>;
}

/** Runs the helper in a sandbox with these arguments. */
export interface HelperRunner {
  exec: (sandbox: string, args: string[]) => Promise<CommandResult>;
  stream: (
    sandbox: string,
    args: string[],
    signal?: AbortSignal
  ) => ReadableStream<Uint8Array>;
}

const checkId = (id: string) => {
  if (!RUN_ID.test(id)) {
    throw new CommandError(`Not a run id: ${id}`);
  }
  return id;
};

const STATES = new Set(["exited", "lost", "running", "stopped"]);

/** Parses `list`'s lines; see run-helper.sh. Lines it can't read are skipped. */
export const parseRunList = (text: string): Run[] =>
  text
    .split("\n")
    .flatMap((line): Run[] => {
      const [id, startedAt, state, code, size, command, cwd] = line.split("\t");
      if (
        id === undefined ||
        startedAt === undefined ||
        state === undefined ||
        !STATES.has(state) ||
        command === undefined ||
        cwd === undefined
      ) {
        return [];
      }
      const exitCode = code === "" ? undefined : Number(code);
      return [
        {
          // The helper stores it with a final line break.
          command: Buffer.from(command, "base64")
            .toString("utf-8")
            .replace(/\n$/u, ""),
          cwd: Buffer.from(cwd, "base64").toString("utf-8"),
          exitCode: Number.isInteger(exitCode) ? exitCode : undefined,
          id,
          logSize: Number(size) || 0,
          startedAt,
          state: state as Run["state"],
        },
      ];
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));

/** Parses `package`'s output: the package manager, then package.json. */
export const parsePackage = (text: string): PackageScripts | undefined => {
  const newline = text.indexOf("\n");
  if (newline === -1) {
    return undefined;
  }
  const manager = text.slice(0, newline).trim();
  let json: unknown;
  try {
    json = JSON.parse(text.slice(newline + 1));
  } catch {
    return undefined;
  }
  const scripts =
    typeof json === "object" && json !== null && "scripts" in json
      ? json.scripts
      : undefined;
  if (typeof scripts !== "object" || scripts === null) {
    return { manager, scripts: {} };
  }
  return {
    manager,
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    ),
  };
};

/** Starting and stopping wait in the sandbox briefly; listing is quick. */
export const RUN_TIMEOUT_MS = 30_000;

export const createRuns = ({ exec, stream }: HelperRunner): Runs => {
  const helper = async (sandbox: string, args: string[]) => {
    const result = await exec(sandbox, args);
    if (result.exitCode !== 0) {
      const detail = [result.stdout.trim(), result.stderr.trim()]
        .filter((text) => text !== "")
        .join("\n");
      throw new CommandError(
        `The run helper failed (${args[0]}): ${detail || `exit code ${result.exitCode}`}`
      );
    }
    return result.stdout;
  };

  return {
    list: async (sandbox) => parseRunList(await helper(sandbox, ["list"])),
    log: (sandbox, id, { follow, offset, signal }) =>
      stream(
        sandbox,
        [
          "log",
          checkId(id),
          String(Math.max(0, Math.floor(offset))),
          follow ? "1" : "0",
        ],
        signal
      ),
    packageScripts: async (sandbox, cwd) =>
      parsePackage(await helper(sandbox, ["package", cwd])),
    start: async (sandbox, { command, cwd, id }) => {
      await helper(sandbox, [
        "start",
        checkId(id),
        cwd,
        String(RUN_COLUMNS),
        String(RUN_ROWS),
        command,
      ]);
    },
    stop: async (sandbox, id) => {
      await helper(sandbox, ["stop", checkId(id)]);
    },
  };
};

interface FakeRun extends Run {
  chunks: Uint8Array[];
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
}

const encoder = new TextEncoder();

/**
 * Stand-in runs for development without `sbx`: each run prints its command
 * and a coloured progress bar that redraws itself, then exits with 0, or 1
 * when the command mentions "fail". They live until the Panel stops.
 */
export const createFakeRuns = (): Runs => {
  const sandboxes = new Map<string, Map<string, FakeRun>>();
  const runsOf = (sandbox: string) => {
    let runs = sandboxes.get(sandbox);
    if (runs === undefined) {
      runs = new Map();
      sandboxes.set(sandbox, runs);
    }
    return runs;
  };
  const find = (sandbox: string, id: string) => {
    const run = runsOf(sandbox).get(id);
    if (run === undefined) {
      throw new CommandError(`(fake) no run ${id}`);
    }
    return run;
  };
  const write = (run: FakeRun, text: string) => {
    const bytes = encoder.encode(text);
    run.chunks.push(bytes);
    run.logSize += bytes.length;
    for (const listener of run.listeners) {
      listener();
    }
  };
  const finish = (run: FakeRun, exitCode: number) => {
    clearInterval(run.timer);
    run.timer = undefined;
    run.state = "exited";
    run.exitCode = exitCode;
    for (const listener of run.listeners) {
      listener();
    }
  };
  const bytesFrom = (run: FakeRun, offset: number) => {
    const all = new Uint8Array(run.logSize);
    let at = 0;
    for (const chunk of run.chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return all.slice(offset);
  };

  return {
    list: (sandbox) =>
      Promise.resolve(
        [...runsOf(sandbox).values()].map(
          ({ command, cwd, exitCode, id, logSize, startedAt, state }) => ({
            command,
            cwd,
            exitCode,
            id,
            logSize,
            startedAt,
            state,
          })
        )
      ),
    log: (sandbox, id, { follow, offset, signal }) => {
      const run = find(sandbox, id);
      let sent = Math.max(0, offset);
      let listener: (() => void) | undefined;
      const stop = () => {
        if (listener !== undefined) {
          run.listeners.delete(listener);
        }
      };
      return new ReadableStream<Uint8Array>({
        cancel: stop,
        start: (controller) => {
          const flush = () => {
            if (sent < run.logSize) {
              controller.enqueue(bytesFrom(run, sent));
              sent = run.logSize;
            }
            if (!follow || run.state !== "running" || signal?.aborted) {
              stop();
              controller.close();
              return true;
            }
            return false;
          };
          if (!flush()) {
            listener = () => {
              flush();
            };
            run.listeners.add(listener);
          }
        },
      });
    },
    packageScripts: () =>
      Promise.resolve({
        manager: "pnpm",
        scripts: { build: "vite build", dev: "vite dev", test: "vitest run" },
      }),
    start: (sandbox, { command, cwd, id }) => {
      const run: FakeRun = {
        chunks: [],
        command,
        cwd,
        exitCode: undefined,
        id,
        listeners: new Set(),
        logSize: 0,
        startedAt: new Date().toISOString(),
        state: "running",
        timer: undefined,
      };
      runsOf(sandbox).set(id, run);
      write(run, `\u001B[1m$ ${command}\u001B[0m\r\n`);
      let percent = 0;
      run.timer = setInterval(() => {
        percent += 5;
        const filled = Math.round(percent / 5);
        write(
          run,
          `\r\u001B[36m[${"#".repeat(filled)}${" ".repeat(20 - filled)}]\u001B[0m ${percent}%`
        );
        if (percent >= 100) {
          const failed = command.includes("fail");
          write(
            run,
            failed
              ? "\r\n\u001B[31mFailed.\u001B[0m\r\n"
              : "\r\n\u001B[32mDone.\u001B[0m\r\n"
          );
          finish(run, failed ? 1 : 0);
        }
      }, 200);
      run.timer.unref();
      return Promise.resolve();
    },
    stop: (sandbox, id) => {
      const run = find(sandbox, id);
      if (run.state === "running") {
        write(run, "\r\n^C\r\n");
        finish(run, 143);
        run.state = "stopped";
      }
      return Promise.resolve();
    },
  };
};
