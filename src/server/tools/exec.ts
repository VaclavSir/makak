import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Added to the Panel's environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Runs a host command. Arguments are passed as an array and no shell is
 * involved, so sandbox names, branch names and the like are never interpreted.
 * A non-zero exit resolves; only failing to run the command at all rejects.
 */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions
) => Promise<CommandResult>;

export class CommandError extends Error {
  override name = "CommandError";
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

interface ExecFileError extends Error {
  code?: number | string | null;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
}

export const exec: Exec = async (
  command,
  args,
  { cwd, env, timeoutMs } = {}
) => {
  try {
    const { stderr, stdout } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf-8",
      env: env === undefined ? undefined : { ...process.env, ...env },
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      timeout: timeoutMs,
    });
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    const {
      code,
      killed,
      message,
      stderr = "",
      stdout = "",
    } = error as ExecFileError;
    if (killed === true && timeoutMs !== undefined) {
      throw new CommandError(
        `\`${command} ${args.join(" ")}\` timed out after ${timeoutMs / 1000}s`
      );
    }
    if (typeof code === "number") {
      return { exitCode: code, stderr, stdout };
    }
    if (code === "ENOENT") {
      throw new CommandError(`\`${command}\` is not installed or not on PATH`);
    }
    throw new CommandError(`\`${command}\` failed: ${message}`);
  }
};

/** Like `exec`, but a non-zero exit rejects, with the command's stderr. */
export const execChecked = async (
  run: Exec,
  command: string,
  args: readonly string[],
  options?: ExecOptions
): Promise<string> => {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new CommandError(
      `\`${command} ${args.join(" ")}\` failed: ${detail}`
    );
  }
  return result.stdout;
};

/** The first line of a command's output, such as a version. */
export const firstLine = (text: string): string =>
  text.trim().split("\n")[0] ?? "";
