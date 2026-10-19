import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { argSpecs, isMap, mergeEnv } from "../lib/env-files.ts";

// The env directory: env files the user combines into a sandbox. The Panel
// reads them for the create form and for warnings; `sbx env` is the one that
// applies them.

/** An env file's name: never a path. */
export const ENV_FILE = /^[^/\\]+\.sbxenv\.ya?ml$/u;

export interface EnvFile {
  /** The `args:` block as written, for the create form. */
  args: unknown;
  /** The parsed file. Undefined when it can't be read or parsed. */
  content: unknown;
  /** Why the file can't be used, if it can't. */
  error: string | undefined;
  /** SHA-256 of the file, to tell whether it changed since its plan was shown. */
  hash: string;
  /** The file name, e.g. `00-base.sbxenv.yaml`. */
  name: string;
  path: string;
}

/** Reads and parses one env file. Never throws: problems go in `error`. */
export const readEnvFile = async (file: string): Promise<EnvFile> => {
  const base = {
    args: undefined,
    content: undefined,
    name: path.basename(file),
    path: file,
  };
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    return {
      ...base,
      error: code === "ENOENT" ? "The file no longer exists." : message,
      hash: "",
    };
  }
  const hash = createHash("sha256").update(text).digest("hex");
  let content: unknown;
  try {
    content = parse(text);
  } catch (error) {
    return {
      ...base,
      error: `Not valid YAML: ${(error as Error).message}`,
      hash,
    };
  }
  if (!isMap(content)) {
    return { ...base, error: "Not a YAML mapping.", hash };
  }
  return {
    args: content.args,
    content,
    error: undefined,
    hash,
    name: base.name,
    path: file,
  };
};

/**
 * Every `*.sbxenv.yaml` in the env directory, sorted by name, so a base such
 * as `00-base.sbxenv.yaml` comes first. A missing directory has none.
 */
export const listEnvFiles = async (envDir: string): Promise<EnvFile[]> => {
  let names: string[];
  try {
    names = await readdir(envDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = names.filter((name) => ENV_FILE.test(name)).toSorted();
  return Promise.all(files.map((name) => readEnvFile(path.join(envDir, name))));
};

const REFERENCE = /\$?\$\{\{\s*env\.args\.(?<name>[\w-]+)\s*\}\}/gu;

/**
 * Substitutes `${{ env.args.NAME }}` in a value, as far as the Panel needs it
 * for warnings. `$${{ … }}` stays literal, and unknown args are left alone.
 */
export const substituteArgs = (
  value: string,
  args: Record<string, string>
): string =>
  value.replaceAll(REFERENCE, (match, name: string) => {
    if (match.startsWith("$$")) {
      return match.slice(1);
    }
    return args[name] ?? match;
  });

/** A boolean setting, which may be written as an arg reference. */
const isTrue = (value: unknown, args: Record<string, string>) =>
  value === true ||
  (typeof value === "string" && substituteArgs(value, args) === "true");

const describePath = (value: unknown, args: Record<string, string>) =>
  typeof value === "string" ? substituteArgs(value, args) : "(no path)";

/**
 * Where the merged env departs from the Makak workflow. Shown, never
 * enforced: the plan from `sbx env plan` is the authority on what applies.
 * `args` are the values the sandbox gets, defaults included.
 */
export const envWarnings = (
  env: unknown,
  args: Record<string, string>
): string[] => {
  if (!isMap(env)) {
    return [];
  }
  const warnings: string[] = [];
  const { additionalWorkspaces, sandboxOptions, workspace } = env;

  if (typeof workspace === "string") {
    warnings.push(
      `The workspace ${describePath(workspace, args)} is mounted directly, not as a clone, so the agent changes your repository as it works.`
    );
  } else if (isMap(workspace) && !isTrue(workspace.clone, args)) {
    warnings.push(
      `The workspace ${describePath(workspace.path, args)} is mounted directly, not as a clone, so the agent changes your repository as it works.`
    );
  }

  if (Array.isArray(additionalWorkspaces)) {
    for (const mount of additionalWorkspaces) {
      const entry = isMap(mount) ? mount : {};
      if (!isTrue(entry.readOnly, args)) {
        warnings.push(
          `The additional workspace ${describePath(entry.path, args)} is writable. Additional workspaces are mounted directly even in clone mode, so the agent can change it on the host.`
        );
      }
    }
  }

  if (isMap(sandboxOptions) && isTrue(sandboxOptions.writableEnvFiles, args)) {
    warnings.push(
      "The env files are writable from the sandbox, so the agent can change the host commands later runs execute."
    );
  }
  return warnings;
};

/** The `lifecycle.preRemove` host commands, which `sbx env rm` runs. */
export const preRemoveCommands = (
  env: unknown,
  args: Record<string, string>
): string[] => {
  const lifecycle = isMap(env) ? env.lifecycle : undefined;
  const commands = isMap(lifecycle) ? lifecycle.preRemove : undefined;
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.flatMap((entry) =>
    isMap(entry) && typeof entry.command === "string"
      ? [substituteArgs(entry.command, args)]
      : []
  );
};

/** The defaults the files declare, overridden by the values given. */
export const effectiveArgs = (
  env: unknown,
  given: Record<string, string>
): Record<string, string> => {
  const defaults = Object.entries(argSpecs(env)).flatMap(([name, spec]) =>
    spec.default === undefined ? [] : [[name, spec.default] as const]
  );
  return { ...Object.fromEntries(defaults), ...given };
};

/** The files merged in order, as `sbx env` merges them. */
export const mergeEnvFiles = (files: readonly EnvFile[]): unknown =>
  mergeEnv(files.map(({ content }) => content));
