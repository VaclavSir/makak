import path from "node:path";

import {
  argError,
  argSpecs,
  nameError,
  SANDBOX_ARG,
} from "../lib/env-files.ts";
import {
  effectiveArgs,
  ENV_FILE,
  envWarnings,
  mergeEnvFiles,
  preRemoveCommands,
  readEnvFile,
} from "./envs.ts";
import type { EnvFile } from "./envs.ts";
import type { Sandboxes } from "./sandboxes.ts";
import type { EnvRecord, SandboxStore } from "./state.ts";
import type { EnvSpec, Sandbox, Sbx } from "./tools/index.ts";

// Creating, starting, stopping and removing sandboxes. Every change that
// applies env files follows a plan the user has seen: `sbx env plan` first,
// then `sbx env run --force` only if the files are still the ones planned.

/** A problem to show the user as it is. */
export class LifecycleError extends Error {
  override name = "LifecycleError";
}

/** Use this, not `instanceof`; see `isStateError`. */
export const isLifecycleError = (error: unknown): error is LifecycleError =>
  error instanceof Error && error.name === "LifecycleError";

/**
 * The message of an error the user should see, such as a failed `sbx`
 * command, or undefined for anything else, which is a bug.
 */
export const userMessage = (error: unknown): string | undefined =>
  error instanceof Error &&
  ["CommandError", "LifecycleError", "StateError"].includes(error.name)
    ? error.message
    : undefined;

/** What the create form submits. */
export interface CreateRequest {
  /** Values for the args; empty ones are left to the files' defaults. */
  args: Record<string, string>;
  /** File names in the env directory. */
  files: string[];
  name: string;
}

export interface Plan {
  /** Each file's hash when the plan was made, in order. */
  hashes: string[];
  /** What `sbx env plan` printed. */
  output: string;
  spec: EnvSpec;
  warnings: string[];
}

/** A sandbox as the page that acts on it saw it. */
export interface Target {
  id: string;
  name: string;
}

/** What removing a sandbox involves, for its confirmation. */
export interface Removal {
  /** Hashes of the env files, when they are used. */
  hashes: string[];
  /** Host commands `sbx env rm` runs first. */
  hostCommands: string[];
  /**
   * `env` removes with `sbx env rm` and the recorded files. `rm` uses
   * `sbx rm`: the sandbox is unmanaged, or its env files are gone.
   */
  method: "env" | "rm";
  hasNotes: boolean;
}

export interface Inspection {
  /** Set when the Panel created the sandbox. */
  env: EnvRecord | undefined;
  /**
   * Why the recorded env files can't be used, if they can't. The sandbox is
   * then started with `sbx run` and removed with `sbx rm`.
   */
  envProblem: string | undefined;
  notes: string;
  removal: Removal;
  /** Workflow warnings, from the env files as they are now. */
  warnings: string[];
}

export interface Lifecycle {
  planCreate: (request: CreateRequest) => Promise<Plan>;
  create: (request: CreateRequest, hashes: string[]) => Promise<Sandbox>;
  /** Only managed sandboxes with usable env files have a plan to start. */
  planStart: (target: Target) => Promise<Plan>;
  /** `hashes` from the plan, or none when there is no plan. */
  start: (target: Target, hashes: string[]) => Promise<void>;
  stop: (target: Target) => Promise<void>;
  /** What the sandbox page shows about how the sandbox is managed. */
  inspect: (target: Target) => Promise<Inspection>;
  /** `confirmation` must be the sandbox's name. */
  remove: (
    target: Target,
    confirmation: string,
    hashes: string[]
  ) => Promise<void>;
}

export interface LifecycleOptions {
  envDir: string;
  now?: () => Date;
  sandboxes: Sandboxes;
  sbx: Sbx;
  store: SandboxStore;
}

const specOf = ({ args, files, name }: EnvRecord): EnvSpec => ({
  args,
  files,
  name,
});

/** What is wrong with each file that can't be used. */
const brokenFiles = (files: readonly EnvFile[]) =>
  files.flatMap(({ error, path: file }) =>
    error === undefined ? [] : [`${file}: ${error}`]
  );

/** Reads env files, all of which must be usable. */
const readFiles = async (paths: readonly string[]) => {
  const files = await Promise.all(paths.map(readEnvFile));
  const problems = brokenFiles(files);
  if (problems.length > 0) {
    throw new LifecycleError(problems.join("\n"));
  }
  return files;
};

const SINCE_PLAN = {
  next: "Review the new plan.",
  since: "the plan was shown",
};

const SINCE_PAGE = {
  next: "Reload the page to see what removing it runs now.",
  since: "this page was loaded",
};

/** Refuses to apply files that changed since the user last saw them. */
const checkUnchanged = (
  files: readonly EnvFile[],
  hashes: readonly string[],
  { next, since }: typeof SINCE_PLAN
) => {
  const changed = files.filter((file, index) => file.hash !== hashes[index]);
  if (changed.length > 0 || files.length !== hashes.length) {
    const names = changed.map(({ name }) => name).join(", ");
    throw new LifecycleError(
      `The env files changed since ${since}${names === "" ? "" : ` (${names})`}. ${next}`
    );
  }
};

/** Runs a follow-up whose failure must not hide what came before it. */
const quietly = async (followUp: () => Promise<unknown>) => {
  try {
    await followUp();
  } catch {
    // The earlier outcome is what the user needs to see.
  }
};

export const createLifecycle = ({
  envDir,
  now = () => new Date(),
  sandboxes,
  sbx,
  store,
}: LifecycleOptions): Lifecycle => {
  // One change per sandbox name at a time: a double click must not run two
  // creates, or a stop in the middle of a remove.
  const busy = new Set<string>();

  const exclusive = async <T>(name: string, change: () => Promise<T>) => {
    if (busy.has(name)) {
      throw new LifecycleError(
        `${name} is already being changed. Wait for that to finish.`
      );
    }
    busy.add(name);
    try {
      return await change();
    } finally {
      busy.delete(name);
      sandboxes.invalidate();
    }
  };

  /** The sandbox the page showed, if it still has that name. */
  const resolve = async ({ id, name }: Target) => {
    const sandbox = await sandboxes.find(name);
    if (sandbox === undefined) {
      throw new LifecycleError(`There is no sandbox named ${name} any more.`);
    }
    if (sandbox.id !== id) {
      throw new LifecycleError(
        `${name} was replaced by a new sandbox with the same name. Reload the page.`
      );
    }
    return sandbox;
  };

  /** Checks a create request, and turns it into what `sbx env` runs with. */
  const prepareCreate = async ({ args, files: names, name }: CreateRequest) => {
    const problems: string[] = [];
    const invalidName = nameError(name);
    if (invalidName !== undefined) {
      problems.push(invalidName);
    } else if ((await sandboxes.find(name)) !== undefined) {
      problems.push(`A sandbox named ${name} already exists.`);
    }
    if (names.length === 0) {
      problems.push("Choose at least one env file.");
    }
    for (const file of names) {
      if (!ENV_FILE.test(file)) {
        problems.push(`${file} is not an env file name.`);
      }
    }
    if (problems.length > 0) {
      throw new LifecycleError(problems.join("\n"));
    }

    // Directory order, so a base such as 00-base comes first.
    const paths = [...new Set(names)]
      .toSorted()
      .map((file) => path.join(envDir, file));
    const files = await readFiles(paths);
    const merged = mergeEnvFiles(files);
    const specs = argSpecs(merged);

    for (const arg of Object.keys(args)) {
      if (!Object.hasOwn(specs, arg)) {
        problems.push(`The env files don't declare the arg ${arg}.`);
      }
    }
    const values: [string, string][] = [];
    for (const [arg, spec] of Object.entries(specs)) {
      const given = Object.hasOwn(args, arg) ? args[arg] : undefined;
      const value = arg === SANDBOX_ARG ? name : (given ?? "");
      const invalid = argError(arg, spec, value);
      if (invalid !== undefined) {
        problems.push(invalid);
      } else if (value !== "") {
        values.push([arg, value]);
      }
    }
    if (problems.length > 0) {
      throw new LifecycleError(problems.join("\n"));
    }
    return {
      files,
      merged,
      spec: { args: Object.fromEntries(values), files: paths, name },
    };
  };

  const plan = async (
    spec: EnvSpec,
    files: readonly EnvFile[],
    merged: unknown
  ): Promise<Plan> => ({
    hashes: files.map(({ hash }) => hash),
    output: await sbx.envPlan(spec),
    spec,
    warnings: envWarnings(merged, effectiveArgs(merged, spec.args)),
  });

  /**
   * The record of a sandbox, and its env files when it is managed and they
   * can all be read.
   */
  const recorded = async (id: string) => {
    const { env, notes } = await store.get(id);
    if (env === undefined) {
      return { env, files: undefined, notes, problem: undefined };
    }
    const files = await Promise.all(env.files.map(readEnvFile));
    const broken = brokenFiles(files);
    return broken.length === 0
      ? { env, files, notes, problem: undefined }
      : {
          env,
          files: undefined,
          notes,
          problem: `The env files it was created from can't be read: ${broken.join("; ")}`,
        };
  };

  return {
    create: (request, hashes) =>
      exclusive(request.name, async () => {
        // Fresh, so a sandbox created a moment ago under this name is seen.
        sandboxes.invalidate();
        const { files, spec } = await prepareCreate(request);
        checkUnchanged(files, hashes, SINCE_PLAN);
        const record = async () => {
          sandboxes.invalidate();
          const sandbox = await sandboxes.find(spec.name);
          if (sandbox !== undefined) {
            await store.setEnv(sandbox.id, {
              ...spec,
              createdAt: now().toISOString(),
            });
          }
          return sandbox;
        };
        try {
          await sbx.envRun(spec);
        } catch (error) {
          // A sandbox created before the failure is still managed, so it can
          // be removed with its env.
          await quietly(record);
          throw error;
        }
        const sandbox = await record();
        if (sandbox === undefined) {
          throw new LifecycleError(
            `sbx finished, but there is no sandbox named ${spec.name}.`
          );
        }
        return sandbox;
      }),

    inspect: async (target) => {
      const { env, files, notes, problem } = await recorded(target.id);
      const hasNotes = notes !== "";
      if (env === undefined || files === undefined) {
        return {
          env,
          envProblem: problem,
          notes,
          removal: { hasNotes, hashes: [], hostCommands: [], method: "rm" },
          warnings: [],
        };
      }
      const merged = mergeEnvFiles(files);
      const args = effectiveArgs(merged, env.args);
      return {
        env,
        envProblem: undefined,
        notes,
        removal: {
          hasNotes,
          hashes: files.map(({ hash }) => hash),
          hostCommands: preRemoveCommands(merged, args),
          method: "env",
        },
        warnings: envWarnings(merged, args),
      };
    },

    planCreate: async (request) => {
      const { files, merged, spec } = await prepareCreate(request);
      return plan(spec, files, merged);
    },

    planStart: async (target) => {
      await resolve(target);
      const { env, files, problem } = await recorded(target.id);
      if (env === undefined) {
        throw new LifecycleError(
          `${target.name} is not managed by the Panel, so it has no env to plan.`
        );
      }
      if (files === undefined) {
        throw new LifecycleError(`${problem}. Reload the page.`);
      }
      return plan(specOf(env), files, mergeEnvFiles(files));
    },

    remove: (target, confirmation, hashes) =>
      exclusive(target.name, async () => {
        if (confirmation !== target.name) {
          throw new LifecycleError(
            `Type the sandbox's name, ${target.name}, to confirm.`
          );
        }
        await resolve(target);
        const { env, files } = await recorded(target.id);
        if (env === undefined) {
          await sbx.rm(target.name);
          // Nothing to recreate it from; the notes were listed as lost. The
          // sandbox is gone either way, so a record left behind is harmless.
          await quietly(() => store.forget(target.id));
          return;
        }
        if (files === undefined) {
          // Only if the confirmation said so; it promised the env otherwise.
          if (hashes.length > 0) {
            throw new LifecycleError(
              "The env files can't be read any more. Reload the page to see how the sandbox would be removed now."
            );
          }
          await sbx.rm(target.name);
          return;
        }
        checkUnchanged(files, hashes, SINCE_PAGE);
        // The record stays, so the sandbox can be created again.
        await sbx.envRm(specOf(env));
      }),

    start: (target, hashes) =>
      exclusive(target.name, async () => {
        await resolve(target);
        const { env, files } = await recorded(target.id);
        if (env !== undefined && files !== undefined) {
          checkUnchanged(files, hashes, SINCE_PLAN);
          await sbx.envRun(specOf(env));
          return;
        }
        // Without usable env files there is no plan; the page offered a
        // plain start only if it knew that.
        if (hashes.length > 0) {
          throw new LifecycleError(
            "The env files can't be read any more. Reload the page."
          );
        }
        await sbx.start(target.name);
      }),

    stop: (target) =>
      exclusive(target.name, async () => {
        await resolve(target);
        await sbx.stop(target.name);
      }),
  };
};
