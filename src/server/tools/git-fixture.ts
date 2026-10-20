import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { exec, execChecked } from "./exec.ts";

// For tests only: real repositories in a temporary directory. It lives here
// because nothing outside src/server/tools spawns processes.

// Isolated from the user's and the system's git configuration.
const ENV = {
  GIT_AUTHOR_DATE: "2026-10-20T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-20T12:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export interface GitFixture {
  dir: string;
  /** Runs git in `repo`, returning its trimmed output. */
  git: (repo: string, ...args: string[]) => Promise<string>;
  /** A new repository on `main`, with one commit. */
  init: (name: string) => Promise<string>;
  /** A clone of `source`, the way sbx clones a workspace. */
  clone: (source: string, name: string) => Promise<string>;
  /** Commits an empty change on the current branch; returns its SHA. */
  commit: (repo: string, message: string) => Promise<string>;
  remove: () => Promise<void>;
}

const git = async (repo: string, ...args: string[]) => {
  const output = await execChecked(exec, "git", ["-C", repo, ...args], {
    env: ENV,
  });
  return output.trim();
};

const identify = async (repo: string) => {
  await git(repo, "config", "user.name", "Makak Test");
  await git(repo, "config", "user.email", "test@makak.test");
};

const commit = async (repo: string, message: string) => {
  await git(repo, "commit", "--allow-empty", "--quiet", "-m", message);
  return await git(repo, "rev-parse", "HEAD");
};

export const createGitFixture = async (): Promise<GitFixture> => {
  const dir = await mkdtemp(path.join(tmpdir(), "makak-git-"));

  return {
    clone: async (source, name) => {
      const repo = path.join(dir, name);
      await git(dir, "clone", "--quiet", source, repo);
      await identify(repo);
      return repo;
    },
    commit,
    dir,
    git,
    init: async (name) => {
      const repo = path.join(dir, name);
      await git(dir, "init", "--quiet", "--initial-branch=main", repo);
      await identify(repo);
      await commit(repo, "Initial commit");
      return repo;
    },
    remove: () => rm(dir, { force: true, recursive: true }),
  };
};
