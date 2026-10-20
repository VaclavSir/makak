import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  CommandError,
  exec as realExec,
  execChecked,
  firstLine,
} from "./exec.ts";
import type { CommandResult, Exec } from "./exec.ts";
import { createFakeGit, createGit } from "./git.ts";
import type { Git } from "./git.ts";
import { FAKE_SANDBOXES, parseSandboxList } from "./sbx.ts";
import type { EnvSpec, Sandbox } from "./sbx.ts";

export type { Commit, Git, Ref } from "./git.ts";
export type { EnvSpec, Sandbox } from "./sbx.ts";

// Thin wrappers over host tools. Each method maps to one command, and
// parsing stays next to it. Nothing outside this directory spawns processes.

export interface Sbx {
  /** `sbx ls --json`: every sandbox on the host. */
  list: () => Promise<Sandbox[]>;
  /** `sbx env plan`: what applying the env would change, as text. */
  envPlan: (spec: EnvSpec) => Promise<string>;
  /**
   * `sbx env run --detach --force`: creates the sandbox, or starts it, without
   * attaching. `--force` approves the plan for this invocation only, so it
   * must follow a plan the user has seen.
   */
  envRun: (spec: EnvSpec) => Promise<string>;
  /** `sbx env rm --force`: removes the sandbox and its scoped secrets. */
  envRm: (spec: EnvSpec) => Promise<string>;
  /** `sbx run --detach`: starts an existing sandbox without attaching. */
  start: (name: string) => Promise<void>;
  /** `sbx stop`. */
  stop: (name: string) => Promise<void>;
  /** `sbx rm --force`: removes a sandbox and its scoped secrets. */
  rm: (name: string) => Promise<void>;
  /** `sbx version`, as printed. */
  version: () => Promise<string>;
}

export interface Browser {
  open: (url: string) => Promise<void>;
}

export interface Tools {
  browser: Browser;
  git: Git;
  sbx: Sbx;
}

// A wedged sbx daemon must not hang every page load.
const SBX_LIST_TIMEOUT_MS = 15_000;
// Planning may resolve kits; creating may pull images.
const SBX_PLAN_TIMEOUT_MS = 2 * 60_000;
const SBX_CREATE_TIMEOUT_MS = 15 * 60_000;
const SBX_CHANGE_TIMEOUT_MS = 5 * 60_000;

/** What a command printed, both streams: sbx reports progress on either. */
const output = ({ stderr, stdout }: CommandResult) =>
  [stdout.trim(), stderr.trim()].filter((text) => text !== "").join("\n");

/** Runs sbx, rejecting on a non-zero exit with everything it printed. */
const sbx = async (exec: Exec, args: string[], timeoutMs: number) => {
  const result = await exec("sbx", args, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new CommandError(
      `\`sbx ${args.join(" ")}\` failed:\n${output(result) || `exit code ${result.exitCode}`}`
    );
  }
  return output(result);
};

/**
 * Flags as `--flag=value`, so no value is ever read as a flag. Files go last
 * and must be absolute: relative ones would resolve against the Panel's
 * directory, and could start with a dash.
 */
const envArgs = ({ args, files, name }: EnvSpec): string[] => {
  for (const file of files) {
    if (!path.isAbsolute(file)) {
      throw new CommandError(`Env file paths must be absolute: ${file}`);
    }
  }
  return [
    `--name=${name}`,
    ...Object.entries(args).map(([arg, value]) => `--env-arg=${arg}=${value}`),
    ...files,
  ];
};

const browserCommand = (platform: NodeJS.Platform): string | undefined => {
  if (platform === "darwin") {
    return "open";
  }
  if (platform === "linux") {
    return "xdg-open";
  }
  return undefined;
};

export const createTools = (
  exec: Exec = realExec,
  platform: NodeJS.Platform = process.platform
): Tools => ({
  browser: {
    open: async (url) => {
      const command = browserCommand(platform);
      if (command === undefined) {
        throw new Error(`Opening a browser is not supported on ${platform}`);
      }
      await execChecked(exec, command, [url]);
    },
  },
  git: createGit(exec),
  sbx: {
    envPlan: async (spec) =>
      await sbx(exec, ["env", "plan", ...envArgs(spec)], SBX_PLAN_TIMEOUT_MS),
    envRm: async (spec) =>
      await sbx(
        exec,
        ["env", "rm", "--force", ...envArgs(spec)],
        SBX_CHANGE_TIMEOUT_MS
      ),
    envRun: async (spec) =>
      await sbx(
        exec,
        ["env", "run", "--detach", "--force", ...envArgs(spec)],
        SBX_CREATE_TIMEOUT_MS
      ),
    list: async () =>
      parseSandboxList(
        await execChecked(exec, "sbx", ["ls", "--json"], {
          timeoutMs: SBX_LIST_TIMEOUT_MS,
        })
      ),
    rm: async (name) => {
      await sbx(exec, ["rm", "--force", "--", name], SBX_CHANGE_TIMEOUT_MS);
    },
    start: async (name) => {
      await sbx(
        exec,
        ["run", "--detach", `--name=${name}`],
        SBX_CHANGE_TIMEOUT_MS
      );
    },
    stop: async (name) => {
      await sbx(exec, ["stop", "--", name], SBX_CHANGE_TIMEOUT_MS);
    },
    version: async () => firstLine(await execChecked(exec, "sbx", ["version"])),
  },
});

const fakePlan = ({ args, files, name }: EnvSpec) =>
  [
    "(fake plan)",
    `+ sandbox: ${name}`,
    ...files.map((file) => `    file: ${file}`),
    ...Object.entries(args).map(([arg, value]) => `    arg ${arg}: ${value}`),
  ].join("\n");

/**
 * A stand-in sbx for development and tests, starting with `FAKE_SANDBOXES`.
 * It remembers what is created, stopped and removed until the process ends.
 */
export const createFakeSbx = (): Sbx => {
  const sandboxes = structuredClone([...FAKE_SANDBOXES]);

  const find = (name: string) => {
    const sandbox = sandboxes.find((candidate) => candidate.name === name);
    if (sandbox === undefined) {
      throw new CommandError(`(fake) no sandbox named ${name}`);
    }
    return sandbox;
  };
  const remove = (name: string) => {
    sandboxes.splice(sandboxes.indexOf(find(name)), 1);
  };

  return {
    envPlan: (spec) => Promise.resolve(fakePlan(spec)),
    envRm: ({ name }) => {
      remove(name);
      return Promise.resolve(`(fake) removed ${name}`);
    },
    envRun: ({ name }) => {
      const existing = sandboxes.find((sandbox) => sandbox.name === name);
      if (existing === undefined) {
        const now = new Date().toISOString();
        sandboxes.push({
          agent: "claude",
          createdAt: now,
          id: randomUUID(),
          lastUsedAt: now,
          name,
          ports: [],
          status: "running",
          workspaces: [],
        });
      } else {
        existing.status = "running";
      }
      return Promise.resolve(`(fake) ${name} is running`);
    },
    list: () => Promise.resolve(structuredClone(sandboxes)),
    rm: async (name) => {
      await Promise.resolve();
      remove(name);
    },
    start: async (name) => {
      await Promise.resolve();
      find(name).status = "running";
    },
    stop: async (name) => {
      await Promise.resolve();
      find(name).status = "stopped";
    },
    version: () => Promise.resolve("sbx version 0.0.0 (fake)"),
  };
};

/**
 * Stand-ins for development without `sbx` and for tests. The browser is real:
 * the fake mode exists to run the Panel, and opening it is part of that.
 */
export const createFakeTools = (browser = createTools().browser): Tools => ({
  browser,
  git: createFakeGit(),
  sbx: createFakeSbx(),
});
