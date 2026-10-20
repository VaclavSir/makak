import { CommandError, execChecked, firstLine } from "./exec.ts";
import type { CommandResult, Exec } from "./exec.ts";

export interface Commit {
  sha: string;
  subject: string;
}

/** A ref and the commit it points at. */
export interface Ref {
  name: string;
  sha: string;
}

export interface Git {
  /** `git --version`, as printed. */
  version: () => Promise<string>;
  /**
   * The top-level directory of the repository `dir` is in. Undefined when it
   * isn't in one, or doesn't exist.
   */
  topLevel: (dir: string) => Promise<string | undefined>;
  /** Whether the repository has a remote of this name. */
  hasRemote: (repo: string, remote: string) => Promise<boolean>;
  /** The branch a remote's `HEAD` points at; undefined when it is detached. */
  remoteHead: (repo: string, remote: string) => Promise<string | undefined>;
  /**
   * `git fetch`. With `prune`, refs gone from the remote are deleted; with
   * `tags: false`, no tags are fetched.
   */
  fetch: (
    repo: string,
    remote: string,
    options?: { prune?: boolean; refspecs?: string[]; tags?: boolean }
  ) => Promise<void>;
  /** The refs under a prefix such as `refs/heads/`, sorted by name. */
  refs: (repo: string, prefix: string) => Promise<Ref[]>;
  /** The branch checked out in the repository; undefined when detached. */
  currentBranch: (repo: string) => Promise<string | undefined>;
  /** How many commits `from` has that `to` hasn't, and the reverse. */
  aheadBehind: (
    repo: string,
    from: string,
    to: string
  ) => Promise<{ ahead: number; behind: number }>;
  /**
   * Commits reachable from `revs` but from no branch, tag or remote-tracking
   * ref outside the `sandbox-*` remotes: the commits that exist only in
   * `revs`. Newest first, at most `limit` of them, with the total count.
   */
  unreachable: (
    repo: string,
    revs: string[],
    limit: number
  ) => Promise<{ commits: Commit[]; count: number }>;
  /**
   * Moves a branch that isn't checked out to `sha`, or creates it. Only a
   * fast-forward: git refuses anything else.
   */
  fastForward: (repo: string, branch: string, sha: string) => Promise<void>;
  /** `git merge --ff-only`: fast-forwards the checked-out branch. */
  mergeFastForward: (repo: string, sha: string) => Promise<void>;
  /**
   * Pushes `sha` to a branch of a remote. With `lease`, forced, but only if
   * the remote branch is still at that SHA; an empty lease means it must not
   * exist.
   */
  push: (
    repo: string,
    remote: string,
    sha: string,
    branch: string,
    lease?: string
  ) => Promise<string>;
}

// Local commands should be instant; a timeout stops a wedged one blocking a page.
const LOCAL_TIMEOUT_MS = 30_000;
// Talking to a remote: a sandbox's git daemon, or origin.
const REMOTE_TIMEOUT_MS = 2 * 60_000;
// The Panel has no terminal: a credential prompt would wait for nobody.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/**
 * Revisions are passed as full ref names or SHAs only, so none can be read as
 * an option.
 */
const checkRev = (rev: string) => {
  if (!rev.startsWith("refs/") && !SHA.test(rev)) {
    throw new CommandError(`Not a full ref name or SHA: ${rev}`);
  }
  return rev;
};

/** What a command printed, both streams: git reports progress on stderr. */
const output = ({ stderr, stdout }: CommandResult) =>
  [stdout.trim(), stderr.trim()].filter((text) => text !== "").join("\n");

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/**
 * Revision arguments for the commits in `revs` that no branch, tag or
 * remote-tracking ref outside the `sandbox-*` remotes has.
 */
const exclusive = (revs: string[]) => [
  ...revs.map(checkRev),
  "--not",
  "--branches",
  "--tags",
  "--exclude=sandbox-*",
  "--remotes",
];

export const createGit = (exec: Exec): Git => {
  /** Runs git in `repo`, rejecting on a non-zero exit with what it printed. */
  const git = async (repo: string, args: string[], timeoutMs: number) => {
    const result = await exec("git", ["-C", repo, ...args], {
      env: NO_PROMPT,
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new CommandError(
        `\`git ${args.join(" ")}\` failed in ${repo}:\n${output(result) || `exit code ${result.exitCode}`}`
      );
    }
    return result.stdout;
  };

  /** Like `git`, but a non-zero exit is an answer, not an error. */
  const ask = async (repo: string, args: string[]) => {
    const result = await exec("git", ["-C", repo, ...args], {
      env: NO_PROMPT,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  };

  return {
    aheadBehind: async (repo, from, to) => {
      const text = await git(
        repo,
        [
          "rev-list",
          "--left-right",
          "--count",
          `${checkRev(from)}...${checkRev(to)}`,
        ],
        LOCAL_TIMEOUT_MS
      );
      const [ahead = Number.NaN, behind = Number.NaN] = text
        .trim()
        .split(/\s+/u)
        .map(Number);
      return { ahead, behind };
    },
    currentBranch: async (repo) =>
      await ask(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    fastForward: async (repo, branch, sha) => {
      // Fetching from the repository itself refuses a non-fast-forward, and a
      // branch checked out in any worktree.
      await git(
        repo,
        ["fetch", "--no-tags", ".", `${checkRev(sha)}:refs/heads/${branch}`],
        LOCAL_TIMEOUT_MS
      );
    },
    fetch: async (
      repo,
      remote,
      { prune = false, refspecs = [], tags = true } = {}
    ) => {
      await git(
        repo,
        [
          "fetch",
          ...(prune ? ["--prune"] : []),
          ...(tags ? [] : ["--no-tags"]),
          "--",
          remote,
          ...refspecs,
        ],
        REMOTE_TIMEOUT_MS
      );
    },
    hasRemote: async (repo, remote) =>
      (await ask(repo, ["config", "--get", `remote.${remote}.url`])) !==
      undefined,
    mergeFastForward: async (repo, sha) => {
      await git(repo, ["merge", "--ff-only", checkRev(sha)], LOCAL_TIMEOUT_MS);
    },
    push: async (repo, remote, sha, branch, lease) => {
      const ref = `refs/heads/${branch}`;
      const result = await git(
        repo,
        [
          "push",
          "--porcelain",
          ...(lease === undefined
            ? []
            : [`--force-with-lease=${ref}:${lease}`]),
          "--",
          remote,
          `${checkRev(sha)}:${ref}`,
        ],
        REMOTE_TIMEOUT_MS
      );
      return result.trim();
    },
    refs: async (repo, prefix) =>
      lines(
        await git(
          repo,
          ["for-each-ref", "--format=%(objectname) %(refname)", "--", prefix],
          LOCAL_TIMEOUT_MS
        )
      ).map((line) => {
        const [sha = "", ...name] = line.split(" ");
        return { name: name.join(" "), sha };
      }),
    remoteHead: async (repo, remote) => {
      const text = await git(
        repo,
        ["ls-remote", "--symref", "--", remote, "HEAD"],
        REMOTE_TIMEOUT_MS
      );
      const symref = /^ref: refs\/heads\/(?<branch>\S+)\tHEAD$/mu.exec(text);
      return symref?.groups?.branch;
    },
    topLevel: async (dir) => await ask(dir, ["rev-parse", "--show-toplevel"]),
    unreachable: async (repo, revs, limit) => {
      if (revs.length === 0) {
        return { commits: [], count: 0 };
      }
      const [count, log] = await Promise.all([
        git(
          repo,
          ["rev-list", "--count", ...exclusive(revs)],
          LOCAL_TIMEOUT_MS
        ),
        git(
          repo,
          [
            "log",
            "--format=%H%x00%s",
            `--max-count=${limit}`,
            ...exclusive(revs),
          ],
          LOCAL_TIMEOUT_MS
        ),
      ]);
      return {
        commits: lines(log).map((line) => {
          const [sha = "", subject = ""] = line.split("\0");
          return { sha, subject };
        }),
        count: Number(count.trim()),
      };
    },
    version: async () =>
      firstLine(await execChecked(exec, "git", ["--version"])),
  };
};

const none = () =>
  Promise.reject(new CommandError("(fake) git has no repositories"));

/**
 * A stand-in that finds no repositories, so no sandbox gets a Git section.
 * Flows that need Git are tested against real repositories instead.
 */
export const createFakeGit = (): Git => ({
  aheadBehind: none,
  currentBranch: none,
  fastForward: none,
  fetch: none,
  hasRemote: () => Promise.resolve(false),
  mergeFastForward: none,
  push: none,
  refs: none,
  remoteHead: none,
  // oxlint-disable-next-line unicorn/no-useless-undefined -- no repository
  topLevel: () => Promise.resolve(undefined),
  unreachable: none,
  version: () => Promise.resolve("git version 0.0.0 (fake)"),
});
