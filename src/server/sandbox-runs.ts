import { randomBytes } from "node:crypto";

import type { Config } from "./config.ts";
import { createShared } from "./shared.ts";
import type { Shared } from "./shared.ts";
import type { Run, Runs, Sandbox } from "./tools/index.ts";

// What can be run in a sandbox, and running it: commands configured for its
// project, its package.json scripts, anything typed, and one-shot prompts to
// its agent. The runs themselves live in the sandbox; see tools/runs.ts.

/** A problem to show the user as it is. */
export class RunError extends Error {
  override name = "RunError";
}

/** A configured command, with the directory it runs in. */
export interface RunCommand {
  command: string;
  cwd: string;
  label: string;
}

export interface PackageScripts {
  /** Where the package.json is. */
  cwd: string;
  manager: string;
  names: string[];
}

/** A run still running, as the sidebar shows it. */
export interface ActiveRun {
  command: string;
  id: string;
}

/** How long a sandbox's active runs are reused. Every open tab polls. */
export const ACTIVE_TTL_MS = 10_000;

export interface SandboxRuns {
  /** Commands configured for the sandbox's projects. */
  commands: (sandbox: Sandbox) => RunCommand[];
  /** The scripts in its main workspace's package.json, if it has one. */
  scripts: (sandbox: Sandbox) => Promise<PackageScripts | undefined>;
  /** Newest first. Only a running sandbox can be asked. */
  list: (sandbox: Sandbox) => Promise<Run[]>;
  /**
   * The runs running in each running sandbox, by sandbox id, oldest first.
   * A sandbox is asked at most once per `activeTtlMs`, shared by everyone
   * asking, and its last `list` counts as asking. One that can't be asked
   * is left out. Never fails.
   */
  active: (sandboxes: Sandbox[]) => Promise<Record<string, ActiveRun[]>>;
  /** Returns the new run's id. `cwd` must be one of its workspaces. */
  start: (sandbox: Sandbox, command: string, cwd: string) => Promise<string>;
  /** A script from `scripts`; it must be in its package.json. */
  startScript: (sandbox: Sandbox, script: string) => Promise<string>;
  /** A one-shot prompt to its agent, in its main workspace. */
  startPrompt: (sandbox: Sandbox, prompt: string) => Promise<string>;
  /** Undefined when the sandbox's agent can't take a one-shot prompt. */
  promptCommand: (sandbox: Sandbox, prompt: string) => string | undefined;
  /** Starts the same command in the same directory, as a new run. */
  rerun: (sandbox: Sandbox, id: string) => Promise<string>;
  stop: (sandbox: Sandbox, id: string) => Promise<void>;
  /** The run's log from a byte offset; see `Runs.log`. */
  log: (
    sandbox: Sandbox,
    id: string,
    options: { follow: boolean; offset: number; signal?: AbortSignal }
  ) => ReadableStream<Uint8Array>;
}

/** Quotes a value for bash, so it is one word, taken literally. */
export const shellQuote = (value: string): string =>
  /^[\w./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * How each agent takes a one-shot prompt, without a terminal. `--` ends the
 * options, so a prompt starting with a dash is never read as one.
 */
const PROMPTS: Record<string, (prompt: string) => string> = {
  claude: (prompt) => `claude -p -- ${shellQuote(prompt)}`,
  codex: (prompt) => `codex exec -- ${shellQuote(prompt)}`,
};

const trailingSlash = /\/+$/u;
const samePath = (a: string, b: string) =>
  a.replace(trailingSlash, "") === b.replace(trailingSlash, "");

/** Sortable and unique: the time it started, then random hex. */
const newRunId = (now: Date) =>
  `${now
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace("T", "-")
    .slice(0, 15)}-${randomBytes(3).toString("hex")}`;

const requireRunning = (sandbox: Sandbox) => {
  if (sandbox.status !== "running") {
    throw new RunError(`${sandbox.name} isn't running. Start it first.`);
  }
};

const activeOf = (listed: Run[]): ActiveRun[] =>
  listed
    .filter((run) => run.state === "running")
    .map(({ command, id }) => ({ command, id }));

export const createSandboxRuns = ({
  activeTtlMs = ACTIVE_TTL_MS,
  now = () => new Date(),
  projects,
  runs,
}: {
  activeTtlMs?: number;
  now?: () => Date;
  projects: Config["runs"]["projects"];
  runs: Runs;
}): SandboxRuns => {
  // Each running sandbox's active runs, by sandbox id.
  const activity = new Map<string, Shared<ActiveRun[]>>();

  const activityOf = (sandbox: Sandbox) => {
    let shared = activity.get(sandbox.id);
    if (shared === undefined) {
      shared = createShared(
        async () => activeOf(await runs.list(sandbox.name)),
        { now: () => now().getTime(), ttlMs: activeTtlMs }
      );
      activity.set(sandbox.id, shared);
    }
    return shared;
  };

  const remember = (sandbox: Sandbox, listed: Run[]) => {
    activityOf(sandbox).set(activeOf(listed));
  };

  // A run started or stopped from here shows at the next poll.
  const forget = (sandbox: Sandbox) => {
    activity.get(sandbox.id)?.forget();
  };

  const activeIn = async (
    sandbox: Sandbox
  ): Promise<ActiveRun[] | undefined> => {
    try {
      return await activityOf(sandbox).get();
    } catch {
      // Left out; the next poll asks again.
    }
  };

  const start = async (sandbox: Sandbox, command: string, cwd: string) => {
    requireRunning(sandbox);
    if (command.trim() === "") {
      throw new RunError("Type a command to run.");
    }
    if (!sandbox.workspaces.some((workspace) => samePath(workspace, cwd))) {
      throw new RunError(`${cwd} isn't one of ${sandbox.name}'s workspaces.`);
    }
    const id = newRunId(now());
    await runs.start(sandbox.name, { command, cwd, id });
    forget(sandbox);
    return id;
  };

  const scripts = async (sandbox: Sandbox) => {
    const [cwd] = sandbox.workspaces;
    if (cwd === undefined || sandbox.status !== "running") {
      return;
    }
    const found = await runs.packageScripts(sandbox.name, cwd);
    return found === undefined
      ? undefined
      : {
          cwd,
          manager: found.manager,
          names: Object.keys(found.scripts).toSorted(),
        };
  };

  return {
    active: async (sandboxes) => {
      const running = sandboxes.filter(
        (sandbox) => sandbox.status === "running"
      );
      // Sandboxes that stopped or are gone are asked afresh when they run.
      for (const id of activity.keys()) {
        if (!running.some((sandbox) => sandbox.id === id)) {
          activity.delete(id);
        }
      }
      const answers = await Promise.all(
        running.map(async (sandbox) => {
          const active = await activeIn(sandbox);
          return active === undefined ? [] : [[sandbox.id, active] as const];
        })
      );
      return Object.fromEntries(answers.flat());
    },

    commands: (sandbox) =>
      projects.flatMap(({ commands, path }) =>
        sandbox.workspaces.some((workspace) => samePath(workspace, path))
          ? commands.map((command) => ({ ...command, cwd: path }))
          : []
      ),

    list: async (sandbox) => {
      requireRunning(sandbox);
      const listed = await runs.list(sandbox.name);
      remember(sandbox, listed);
      return listed.toReversed();
    },

    log: (sandbox, id, options) => {
      requireRunning(sandbox);
      return runs.log(sandbox.name, id, options);
    },

    promptCommand: (sandbox, prompt) => {
      const command = PROMPTS[sandbox.agent ?? ""];
      return command === undefined ? undefined : command(prompt);
    },

    rerun: async (sandbox, id) => {
      requireRunning(sandbox);
      const listed = await runs.list(sandbox.name);
      const run = listed.find((each) => each.id === id);
      if (run === undefined) {
        throw new RunError(`${sandbox.name} has no run ${id}.`);
      }
      return await start(sandbox, run.command, run.cwd);
    },

    scripts,

    start,

    startPrompt: async (sandbox, prompt) => {
      const command = PROMPTS[sandbox.agent ?? ""];
      const [cwd] = sandbox.workspaces;
      if (command === undefined || cwd === undefined) {
        throw new RunError(
          `${sandbox.name}'s agent can't take a prompt from the Panel.`
        );
      }
      if (prompt.trim() === "") {
        throw new RunError("Type a prompt.");
      }
      return await start(sandbox, command(prompt), cwd);
    },

    startScript: async (sandbox, script) => {
      const found = await scripts(sandbox);
      // A name starting with a dash would be read as an option.
      if (
        found === undefined ||
        !found.names.includes(script) ||
        script.startsWith("-")
      ) {
        throw new RunError(`There is no script ${script} in package.json.`);
      }
      return await start(
        sandbox,
        `${found.manager} run ${shellQuote(script)}`,
        found.cwd
      );
    },

    stop: async (sandbox, id) => {
      requireRunning(sandbox);
      await runs.stop(sandbox.name, id);
      forget(sandbox);
    },
  };
};
