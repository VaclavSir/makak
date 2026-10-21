// Commands the Panel shows for copying into a terminal. They are only ever
// displayed, never run, but they must still paste safely whatever the name.

// A leading `=` is excluded: zsh expands `=word` to the path of a command.
const SAFE = /^[\w@%+:,./-][\w@%+=:,./-]*$/u;

/** Quotes a word for POSIX shells and zsh, leaving harmless ones bare. */
export const shellQuote = (word: string): string =>
  SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const command = (...words: string[]) => words.map(shellQuote).join(" ");

export interface SandboxCommand {
  label: string;
  value: string;
}

/** Starts the sandbox if needed and attaches its agent. */
export const runCommand = (name: string): string =>
  command("sbx", "run", "--name", name);

/** A workspace as sbx lists it, without its `:ro` mode. */
export const workspacePath = (workspace: string): string =>
  workspace.replace(/:ro$/u, "");

/**
 * Terminal commands, the SSH host and the main workspace's path, the same
 * inside the sandbox, for a sandbox. `sshSuffix` matches the host pattern
 * `sbx setup ssh` wrote, `*.sbx` by default.
 */
export const sandboxCommands = (
  name: string,
  sshSuffix: string,
  workspaces: readonly string[] = []
): SandboxCommand[] => [
  { label: "Attach the agent", value: runCommand(name) },
  { label: "Open a shell", value: command("sbx", "exec", "-it", name, "bash") },
  { label: "SSH host", value: `${name}${sshSuffix}` },
  ...(workspaces[0] === undefined
    ? []
    : [{ label: "Workspace", value: workspacePath(workspaces[0]) }]),
];

/** Publishes a sandbox port; without one, `<port>` is left to fill in. */
export const publishCommand = (name: string, port?: number): string =>
  `${command("sbx", "ports", name, "--publish")} ${port ?? "<port>"}`;
