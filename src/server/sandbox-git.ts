import type { Commit, Git, Ref, Sandbox } from "./tools/index.ts";

// The branches of clone-mode sandboxes, as their host repositories hold them.
// sbx serves a sandbox's clone through the `sandbox-<name>` remote, which
// exists only while the sandbox runs, and copies the sandbox's branches to
// refs/sandboxes/<name>/ about once a minute: forced, never pruned, and kept
// after the sandbox stops or is removed. That copy is what the Panel reads.

/** A problem to show the user as it is. */
export class GitError extends Error {
  override name = "GitError";
}

/** The remote pushes go to, and status compares with. */
export const ORIGIN = "origin";

/** How many of the commits on no branch are listed. */
const LISTED_COMMITS = 20;

/** The remote sbx adds to the host repository while a sandbox runs. */
export const sandboxRemote = (name: string) => `sandbox-${name}`;

/** Where sbx copies a sandbox's branches in the host repository. */
export const copyPrefix = (name: string) => `refs/sandboxes/${name}/`;

/** Commits on no host branch, tag or other remote. */
export interface Work {
  /** Newest first; not necessarily all of them. */
  commits: Commit[];
  count: number;
  /** Why they couldn't be counted, if they couldn't. */
  unknown: string | undefined;
}

/** How a sandbox's branch compares with another branch of the same name. */
export interface Comparison {
  /** Commits the sandbox has that the other branch hasn't. */
  ahead: number;
  /** Commits the other branch has that the sandbox hasn't. */
  behind: number;
  sha: string;
}

export interface BranchStatus {
  /** Checked out in the sandbox; only known while it runs. */
  current: boolean;
  /** The host's branch; undefined when it has none. */
  host: Comparison | undefined;
  name: string;
  /** Origin's branch, as last fetched; undefined when it has none. */
  origin: Comparison | undefined;
  sha: string;
}

export interface GitStatus {
  branches: BranchStatus[];
  /** Why the repository couldn't be read, if it couldn't. */
  error: string | undefined;
  hasOrigin: boolean;
  repo: string;
  work: Work;
}

export interface SandboxGit {
  /**
   * The host repository of a clone-mode sandbox: the workspace's repository
   * that has its copied branches or its remote. Undefined for any other.
   */
  repoOf: (sandbox: Sandbox) => Promise<string | undefined>;
  /**
   * Copies a running sandbox's branches now, as sbx does every minute.
   * Does nothing for a sandbox that isn't running or has no repository.
   */
  sync: (sandbox: Sandbox) => Promise<void>;
  /** Undefined for a sandbox without a repository. */
  status: (sandbox: Sandbox) => Promise<GitStatus | undefined>;
  /** Syncs the sandbox if it runs, and fetches origin. */
  refresh: (sandbox: Sandbox) => Promise<void>;
  /**
   * Fast-forwards the host's branch to the sandbox's, creating it if
   * needed. `sha` is what the page showed; the branch must still be there.
   */
  bringToHost: (sandbox: Sandbox, branch: string, sha: string) => Promise<void>;
  /**
   * Pushes a sandbox's branch to origin. With `lease`, forced, if origin's
   * branch is still at that SHA. Returns what git printed.
   */
  push: (
    sandbox: Sandbox,
    branch: string,
    sha: string,
    lease?: string
  ) => Promise<string>;
}

const shasByBranch = (refs: Ref[], prefix: string) =>
  new Map(
    refs.flatMap(({ name, sha }) =>
      name.startsWith(prefix) ? [[name.slice(prefix.length), sha] as const] : []
    )
  );

/** Waits for a promise, ignoring how it ended. */
const settle = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch {
    // Reported to whoever waited for it.
  }
};

export const createSandboxGit = (git: Git): SandboxGit => {
  // One git change per sandbox at a time, so an action never sees the
  // copied branches half-updated by a sync.
  const queues = new Map<string, Promise<unknown>>();

  const serially = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(id) ?? Promise.resolve();
    const run = async () => {
      await settle(previous);
      return await task();
    };
    const next = run();
    const tail = settle(next);
    queues.set(id, tail);
    const forget = async () => {
      await tail;
      if (queues.get(id) === tail) {
        queues.delete(id);
      }
    };
    void forget();
    return next;
  };

  const hasCopy = async (repo: string, name: string) => {
    try {
      const copied = await git.refs(repo, copyPrefix(name));
      return copied.length > 0;
    } catch {
      // Not readable as a repository, so not this sandbox's.
      return false;
    }
  };

  const repoOf = async ({ name, workspaces }: Sandbox) => {
    const repos = await Promise.all(
      workspaces.map(async (workspace) => {
        const repo = await git.topLevel(workspace);
        if (repo === undefined) {
          return;
        }
        return (await git.hasRemote(repo, sandboxRemote(name))) ||
          (await hasCopy(repo, name))
          ? repo
          : undefined;
      })
    );
    return repos.find((repo) => repo !== undefined);
  };

  const requireRepo = async (sandbox: Sandbox) => {
    const repo = await repoOf(sandbox);
    if (repo === undefined) {
      throw new GitError(
        `The Panel found no host repository with ${sandbox.name}'s branches. Is it in clone mode?`
      );
    }
    return repo;
  };

  const syncInto = async ({ name, status }: Sandbox, repo: string) => {
    if (status !== "running") {
      return;
    }
    // As sbx copies them: forced, so a rewritten branch is followed, and not
    // pruned, so a deleted one is kept.
    await git.fetch(repo, sandboxRemote(name), {
      refspecs: [`+refs/heads/*:${copyPrefix(name)}*`],
      tags: false,
    });
  };

  /** The sandbox's copied branch, which must still be at `sha`. */
  const copiedBranch = async (
    sandbox: Sandbox,
    branch: string,
    sha: string
  ) => {
    const repo = await requireRepo(sandbox);
    const ref = `${copyPrefix(sandbox.name)}${branch}`;
    const refs = await git.refs(repo, ref);
    const current = refs.find(({ name }) => name === ref);
    if (current === undefined) {
      throw new GitError(`${sandbox.name} has no branch ${branch}.`);
    }
    if (current.sha !== sha) {
      throw new GitError(
        `${branch} changed in the sandbox since this page was loaded. Reload the page.`
      );
    }
    return repo;
  };

  /** The branch checked out in a running sandbox, if git can tell. */
  const checkedOut = async ({ name, status }: Sandbox, repo: string) => {
    if (status !== "running") {
      return;
    }
    let branch: string | undefined;
    try {
      branch = await git.remoteHead(repo, sandboxRemote(name));
    } catch {
      // Only a hint; the daemon may be starting or stopping.
    }
    return branch;
  };

  const readStatus = async (
    sandbox: Sandbox,
    repo: string
  ): Promise<GitStatus> => {
    const prefix = copyPrefix(sandbox.name);
    const [copied, host, hasOrigin, current] = await Promise.all([
      git.refs(repo, prefix),
      git.refs(repo, "refs/heads/"),
      git.hasRemote(repo, ORIGIN),
      checkedOut(sandbox, repo),
    ]);
    const origin = hasOrigin
      ? await git.refs(repo, `refs/remotes/${ORIGIN}/`)
      : [];
    const hostShas = shasByBranch(host, "refs/heads/");
    const originShas = shasByBranch(origin, `refs/remotes/${ORIGIN}/`);

    const compare = async (sha: string, other: string | undefined) =>
      other === undefined
        ? undefined
        : { ...(await git.aheadBehind(repo, sha, other)), sha: other };
    const branches = await Promise.all(
      [...shasByBranch(copied, prefix)].map(async ([name, sha]) => ({
        current: name === current,
        host: await compare(sha, hostShas.get(name)),
        name,
        origin: await compare(sha, originShas.get(name)),
        sha,
      }))
    );
    const { commits, count } = await git.unreachable(
      repo,
      copied.map(({ name }) => name),
      LISTED_COMMITS
    );
    return {
      branches,
      error: undefined,
      hasOrigin,
      repo,
      work: { commits, count, unknown: undefined },
    };
  };

  return {
    bringToHost: (sandbox, branch, sha) =>
      serially(sandbox.id, async () => {
        const repo = await copiedBranch(sandbox, branch, sha);
        // A branch checked out on the host moves only by merging, which keeps
        // the working tree in step, and refuses to overwrite local changes.
        const onHost = await git.currentBranch(repo);
        await (onHost === branch
          ? git.mergeFastForward(repo, sha)
          : git.fastForward(repo, branch, sha));
      }),

    push: (sandbox, branch, sha, lease) =>
      serially(sandbox.id, async () => {
        const repo = await copiedBranch(sandbox, branch, sha);
        if (!(await git.hasRemote(repo, ORIGIN))) {
          throw new GitError(`${repo} has no ${ORIGIN} remote.`);
        }
        return await git.push(repo, ORIGIN, sha, branch, lease);
      }),

    refresh: (sandbox) =>
      serially(sandbox.id, async () => {
        const repo = await requireRepo(sandbox);
        let failure: unknown;
        try {
          await syncInto(sandbox, repo);
        } catch (error) {
          // Origin is still worth fetching.
          failure = error;
        }
        if (await git.hasRemote(repo, ORIGIN)) {
          await git.fetch(repo, ORIGIN);
        }
        if (failure !== undefined) {
          throw failure;
        }
      }),

    repoOf,

    // Not queued: a page load must not wait for a slow fetch. Actions check
    // that the branch is still what the page showed.
    status: async (sandbox) => {
      const repo = await repoOf(sandbox);
      if (repo === undefined) {
        return;
      }
      try {
        return await readStatus(sandbox, repo);
      } catch (error) {
        // A broken repository must not break the page, or block removal.
        const { message } = error as Error;
        return {
          branches: [],
          error: message,
          hasOrigin: false,
          repo,
          work: {
            commits: [],
            count: 0,
            unknown: `The Panel can't read the repository: ${message}`,
          },
        };
      }
    },

    sync: (sandbox) =>
      serially(sandbox.id, async () => {
        const repo = await repoOf(sandbox);
        if (repo !== undefined) {
          await syncInto(sandbox, repo);
        }
      }),
  };
};
