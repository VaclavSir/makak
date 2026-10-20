import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exec } from "./exec.ts";
import type { Exec } from "./exec.ts";
import { createGitFixture } from "./git-fixture.ts";
import type { GitFixture } from "./git-fixture.ts";
import { createFakeGit, createGit } from "./git.ts";

const git = createGit(exec);

describe("git, against real repositories", () => {
  let fixture: GitFixture;
  let host: string;
  let sandbox: string;

  beforeEach(async () => {
    fixture = await createGitFixture();
    host = await fixture.init("host");
    sandbox = await fixture.clone(host, "sandbox");
    await fixture.git(host, "remote", "add", "sandbox-s", sandbox);
  });

  afterEach(async () => {
    await fixture.remove();
  });

  it("finds the top level of a repository, and nothing outside one", async () => {
    await expect(git.topLevel(host)).resolves.toBe(host);
    await expect(git.topLevel(fixture.dir)).resolves.toBeUndefined();
    await expect(
      git.topLevel(path.join(fixture.dir, "missing"))
    ).resolves.toBeUndefined();
  });

  it("tells whether a remote exists", async () => {
    await expect(git.hasRemote(host, "sandbox-s")).resolves.toBeTruthy();
    await expect(git.hasRemote(host, "sandbox-t")).resolves.toBeFalsy();
  });

  it("reads the branch a remote's HEAD points at", async () => {
    await expect(git.remoteHead(host, "sandbox-s")).resolves.toBe("main");
    await fixture.git(sandbox, "checkout", "--quiet", "--detach");
    await expect(git.remoteHead(host, "sandbox-s")).resolves.toBeUndefined();
  });

  it("fetches with forced updates and pruning", async () => {
    await fixture.git(sandbox, "checkout", "--quiet", "-b", "feature");
    const first = await fixture.commit(sandbox, "First");
    const refspecs = ["+refs/heads/*:refs/remotes/sandbox-s/*"];
    await git.fetch(host, "sandbox-s", { prune: true, refspecs });
    await expect(
      git.refs(host, "refs/remotes/sandbox-s/")
    ).resolves.toStrictEqual([
      { name: "refs/remotes/sandbox-s/feature", sha: first },
      {
        name: "refs/remotes/sandbox-s/main",
        sha: await fixture.git(host, "rev-parse", "main"),
      },
    ]);

    await fixture.git(
      sandbox,
      "commit",
      "--amend",
      "--allow-empty",
      "--quiet",
      "-m",
      "Again"
    );
    await fixture.git(sandbox, "branch", "--quiet", "-D", "main");
    await git.fetch(host, "sandbox-s", { prune: true, refspecs });
    const refs = await git.refs(host, "refs/remotes/sandbox-s/");
    expect(refs.map(({ name }) => name)).toStrictEqual([
      "refs/remotes/sandbox-s/feature",
    ]);
    expect(refs[0]?.sha).not.toBe(first);
  });

  it("leaves tags out when asked", async () => {
    await fixture.git(sandbox, "tag", "agent-tag");
    await git.fetch(host, "sandbox-s", { tags: false });
    await expect(git.refs(host, "refs/tags/")).resolves.toStrictEqual([]);
  });

  it("counts commits ahead and behind", async () => {
    await fixture.commit(sandbox, "One");
    await fixture.commit(sandbox, "Two");
    await fixture.commit(host, "Three");
    await git.fetch(host, "sandbox-s", {
      prune: true,
      refspecs: ["+refs/heads/*:refs/remotes/sandbox-s/*"],
    });
    await expect(
      git.aheadBehind(host, "refs/remotes/sandbox-s/main", "refs/heads/main")
    ).resolves.toStrictEqual({ ahead: 2, behind: 1 });
  });

  it("finds the commits only the given refs hold", async () => {
    await fixture.commit(sandbox, "One");
    const two = await fixture.commit(sandbox, "Two");
    await git.fetch(host, "sandbox-s", {
      prune: true,
      refspecs: ["+refs/heads/*:refs/remotes/sandbox-s/*"],
    });
    // The sandbox remote's own tracking refs don't count as safe.
    await git.fetch(host, "sandbox-s");

    await expect(
      git.unreachable(host, ["refs/remotes/sandbox-s/main"], 1)
    ).resolves.toStrictEqual({
      commits: [{ sha: two, subject: "Two" }],
      count: 2,
    });

    await fixture.git(host, "tag", "kept", two);
    await expect(
      git.unreachable(host, ["refs/remotes/sandbox-s/main"], 10)
    ).resolves.toStrictEqual({ commits: [], count: 0 });
    await expect(git.unreachable(host, [], 10)).resolves.toStrictEqual({
      commits: [],
      count: 0,
    });
  });

  describe("fast-forwarding", () => {
    let ahead: string;

    beforeEach(async () => {
      ahead = await fixture.commit(sandbox, "Ahead");
      await git.fetch(host, "sandbox-s", {
        prune: true,
        refspecs: ["+refs/heads/*:refs/remotes/sandbox-s/*"],
      });
    });

    it("creates a branch, or moves one that isn't checked out", async () => {
      await git.fastForward(host, "copy", ahead);
      await expect(fixture.git(host, "rev-parse", "copy")).resolves.toBe(ahead);
    });

    it("merges into the checked-out branch, which fetch refuses", async () => {
      await expect(git.fastForward(host, "main", ahead)).rejects.toThrow(
        /checked out/u
      );
      await expect(git.currentBranch(host)).resolves.toBe("main");
      await git.mergeFastForward(host, ahead);
      await expect(fixture.git(host, "rev-parse", "main")).resolves.toBe(ahead);
    });

    it("refuses to move a branch that diverged", async () => {
      const diverged = await fixture.commit(host, "Host only");
      await fixture.git(host, "checkout", "--quiet", "--detach");
      await expect(git.currentBranch(host)).resolves.toBeUndefined();
      await expect(git.fastForward(host, "main", ahead)).rejects.toThrow(
        /non-fast-forward|rejected/u
      );
      await expect(fixture.git(host, "rev-parse", "main")).resolves.toBe(
        diverged
      );
    });
  });

  describe("pushing", () => {
    let origin: string;
    let before: string;
    let amended: string;

    beforeEach(async () => {
      origin = path.join(fixture.dir, "origin.git");
      await fixture.git(
        fixture.dir,
        "clone",
        "--quiet",
        "--bare",
        host,
        origin
      );
      await fixture.git(host, "remote", "add", "origin", origin);
      await fixture.git(host, "fetch", "--quiet", "origin");
      before = await fixture.git(host, "rev-parse", "origin/main");
      amended = await fixture.commit(sandbox, "Sandbox");
      await git.fetch(host, "sandbox-s", {
        prune: true,
        refspecs: ["+refs/heads/*:refs/remotes/sandbox-s/*"],
      });
    });

    it("pushes a new branch, refusing an empty lease once it exists", async () => {
      await git.push(host, "origin", amended, "feature");
      await expect(fixture.git(origin, "rev-parse", "feature")).resolves.toBe(
        amended
      );
      await expect(
        git.push(host, "origin", before, "feature", "")
      ).rejects.toThrow(/stale info|rejected/u);
    });

    it("forces only with a lease that still holds", async () => {
      await git.push(host, "origin", amended, "feature");
      await expect(git.push(host, "origin", before, "feature")).rejects.toThrow(
        /rejected/u
      );
      await expect(
        git.push(host, "origin", before, "feature", before)
      ).rejects.toThrow(/stale info|rejected/u);
      await git.push(host, "origin", before, "feature", amended);
      await expect(fixture.git(origin, "rev-parse", "feature")).resolves.toBe(
        before
      );
    });
  });

  it("fetches a remote", async () => {
    const commit = await fixture.commit(sandbox, "New");
    await git.fetch(host, "sandbox-s");
    await expect(
      fixture.git(host, "rev-parse", "sandbox-s/main")
    ).resolves.toBe(commit);
  });
});

const recording = () => {
  const calls: (readonly string[])[] = [];
  const run: Exec = (_, args) => {
    calls.push(args);
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "0\t0\n" });
  };
  return { calls, run };
};

describe(createGit, () => {
  it("passes revisions only as full ref names or SHAs", async () => {
    const { calls, run } = recording();
    const recorded = createGit(run);
    await expect(
      recorded.aheadBehind("/r", "--output=/tmp/x", "refs/heads/main")
    ).rejects.toThrow(/Not a full ref name or SHA/u);
    await expect(recorded.unreachable("/r", ["main"], 1)).rejects.toThrow(
      /Not a full ref name or SHA/u
    );
    await expect(recorded.push("/r", "origin", "HEAD", "main")).rejects.toThrow(
      /Not a full ref name or SHA/u
    );
    expect(calls).toStrictEqual([]);
  });

  it("never lets git prompt for credentials", async () => {
    const envs: (Record<string, string> | undefined)[] = [];
    const run: Exec = (_, __, options) => {
      envs.push(options?.env);
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    };
    await createGit(run).fetch("/r", "origin");
    expect(envs).toStrictEqual([{ GIT_TERMINAL_PROMPT: "0" }]);
  });

  it("puts remotes after --, so none is read as an option", async () => {
    const { calls, run } = recording();
    await createGit(run).fetch("/r", "--upload-pack=x");
    expect(calls).toStrictEqual([
      ["-C", "/r", "fetch", "--", "--upload-pack=x"],
    ]);
  });
});

describe(createFakeGit, () => {
  it("finds no repositories", async () => {
    const fake = createFakeGit();
    await expect(
      fake.topLevel("/Users/me/Projects/x")
    ).resolves.toBeUndefined();
    await expect(fake.version()).resolves.toMatch(/fake/u);
  });
});
