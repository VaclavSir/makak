import { execFile, spawn } from "node:child_process";
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

/**
 * Runs a host command for its output as it comes, such as a log being
 * followed. Arguments are passed as an array, without a shell. Cancelling the
 * stream, or aborting `signal`, kills the command. A non-zero exit errors the
 * stream with what the command printed on stderr, unless it was killed.
 */
export type Stream = (
  command: string,
  args: readonly string[],
  options?: { env?: Record<string, string>; signal?: AbortSignal }
) => ReadableStream<Uint8Array>;

/** How much of a streamed command's stderr is kept for its error. */
const MAX_STREAM_STDERR = 4096;

export const stream: Stream = (command, args, { env, signal } = {}) => {
  const child = spawn(command, args, {
    env: env === undefined ? undefined : { ...process.env, ...env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Set once the stream is closed, errored or cancelled; the controller
  // throws if used after that, and a throw here would bring down the Panel.
  let open = true;
  let killed = false;
  const kill = () => {
    killed = true;
    open = false;
    child.kill();
  };
  signal?.addEventListener("abort", kill, { once: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf-8")}`.slice(0, MAX_STREAM_STDERR);
  });
  return new ReadableStream<Uint8Array>({
    cancel: kill,
    start: (controller) => {
      const close = (error?: Error) => {
        if (!open) {
          return;
        }
        open = false;
        signal?.removeEventListener("abort", kill);
        if (error === undefined) {
          controller.close();
        } else {
          controller.error(error);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (open) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      child.on("close", (code) => {
        close(
          code === 0 || code === null || killed
            ? undefined
            : new CommandError(
                `\`${command}\` failed: ${stderr.trim() || `exit code ${code}`}`
              )
        );
      });
      child.on("error", (error) => {
        close(
          new CommandError(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? `\`${command}\` is not installed or not on PATH`
              : `\`${command}\` failed: ${error.message}`
          )
        );
      });
    },
  });
};
