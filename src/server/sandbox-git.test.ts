import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSandboxGit } from "./sandbox-git.ts";
import type { SandboxGit } from "./sandbox-git.ts";
import { CommandError, exec } from "./tools/exec.ts";
import { createGitFixture } from "./tools/git-fixture.ts";
import type { GitFixture } from "./tools/git-fixture.ts";
import { createGit } from "./tools/git.ts";
import type { Sandbox } from "./tools/index.ts";

describe(createSandboxGit, () => {
  let fixture: GitFixture;
  let host: string;
  let clone: string;
  let sandboxGit: SandboxGit;
  let sandbox: Sandbox;

  /** What sbx does about once a minute while the sandbox runs. */
  const sbxCopies = () =>
    fixture.git(
      host,
      "fetch",
      "--quiet",
      "--no-tags",
      "sandbox-s",
      "+refs/heads/*:refs/sandboxes/s/*"
    );

  /** What sbx does on stop: the remote goes, the copy stays. */
  const sbxStops = async () => {
    await fixture.git(host, "remote", "remove", "sandbox-s");
    sandbox = { ...sandbox, status: "stopped" };
  };

  const branches = async () => {
    const status = await sandboxGit.status(sandbox);
    return status?.branches;
  };

  beforeEach(async () => {
    fixture = await createGitFixture();
    host = await fixture.init("host");
    clone = await fixture.clone(host, "clone");
    await fixture.git(host, "remote", "add", "sandbox-s", clone);
    sandboxGit = createSandboxGit(createGit(exec));
    sandbox = {
      agent: "claude",
      createdAt: undefined,
      id: "id-1",
      lastUsedAt: undefined,
      name: "s",
      ports: [],
      status: "running",
      workspaces: [path.join(fixture.dir, "elsewhere"), host],
    };
  });

  afterEach(async () => {
    await fixture.remove();
  });

  describe("finding the repository", () => {
    it("finds it by the sandbox's remote while it runs", async () => {
      await expect(sandboxGit.repoOf(sandbox)).resolves.toBe(host);
    });

    it("finds it by sbx's copy once it has stopped", async () => {
      await sbxCopies();
      await sbxStops();
      await expect(sandboxGit.repoOf(sandbox)).resolves.toBe(host);
    });

    it("finds none for a sandbox without either", async () => {
      const other = { ...sandbox, name: "other" };
      await expect(sandboxGit.repoOf(other)).resolves.toBeUndefined();
      await expect(sandboxGit.status(other)).resolves.toBeUndefined();
    });
  });

  it("shows sbx's copy against the host, with the branch checked out", async () => {
    await fixture.git(clone, "checkout", "--quiet", "-b", "feature");
    const one = await fixture.commit(clone, "One");
    await fixture.commit(host, "Host");
    await sbxCopies();

    await expect(branches()).resolves.toStrictEqual([
      {
        current: true,
        host: undefined,
        name: "feature",
        origin: undefined,
        sha: one,
      },
      {
        current: false,
        host: {
          ahead: 0,
          behind: 1,
          sha: await fixture.git(host, "rev-parse", "main"),
        },
        name: "main",
        origin: undefined,
        sha: await fixture.git(clone, "rev-parse", "main"),
      },
    ]);
  });

  it("still shows the branches once it has stopped", async () => {
    const one = await fixture.commit(clone, "One");
    await sbxCopies();
    await sbxStops();
    await expect(branches()).resolves.toStrictEqual([
      expect.objectContaining({ current: false, name: "main", sha: one }),
    ]);
  });

  it("lists the commits on no host branch, tag or other remote", async () => {
    await fixture.commit(clone, "One");
    const two = await fixture.commit(clone, "Two");
    await sbxCopies();

    await expect(sandboxGit.status(sandbox)).resolves.toMatchObject({
      error: undefined,
      work: {
        commits: [{ sha: two, subject: "Two" }, { subject: "One" }],
        count: 2,
        unknown: undefined,
      },
    });
  });

  describe("syncing", () => {
    it("copies as sbx does: forced, and keeping deleted branches", async () => {
      await fixture.git(clone, "checkout", "--quiet", "-b", "feature");
      await fixture.commit(clone, "One");
      await sandboxGit.sync(sandbox);
      await fixture.git(
        clone,
        "commit",
        "--amend",
        "--allow-empty",
        "--quiet",
        "-m",
        "Rewritten"
      );
      await fixture.git(clone, "branch", "--quiet", "-D", "main");
      await sandboxGit.sync(sandbox);

      await expect(branches()).resolves.toMatchObject([
        {
          name: "feature",
          sha: await fixture.git(clone, "rev-parse", "feature"),
        },
        { name: "main" },
      ]);
    });

    it("does nothing for a stopped sandbox", async () => {
      await sbxCopies();
      await sbxStops();
      await fixture.commit(clone, "Not copied");
      await sandboxGit.sync(sandbox);
      await expect(branches()).resolves.toMatchObject([
        { sha: await fixture.git(host, "rev-parse", "main") },
      ]);
    });
  });

  describe("bringing a branch to the host", () => {
    it("creates or fast-forwards a branch, merging the checked-out one", async () => {
      await fixture.git(clone, "checkout", "--quiet", "-b", "feature");
      const one = await fixture.commit(clone, "One");
      await fixture.git(clone, "checkout", "--quiet", "main");
      const two = await fixture.commit(clone, "Two");
      await sbxCopies();
      await sbxStops();

      await sandboxGit.bringToHost(sandbox, "feature", one);
      await expect(fixture.git(host, "rev-parse", "feature")).resolves.toBe(
        one
      );
      await sandboxGit.bringToHost(sandbox, "main", two);
      await expect(fixture.git(host, "rev-parse", "HEAD")).resolves.toBe(two);
      await expect(sandboxGit.status(sandbox)).resolves.toMatchObject({
        work: { count: 0 },
      });
    });

    it("refuses a branch that moved since the page showed it", async () => {
      const one = await fixture.commit(clone, "One");
      await sbxCopies();
      await fixture.commit(clone, "Two");
      await sbxCopies();
      await expect(
        sandboxGit.bringToHost(sandbox, "main", one)
      ).rejects.toThrow(/changed in the sandbox/u);
    });

    it("refuses a branch the sandbox doesn't have", async () => {
      await sbxCopies();
      await expect(
        sandboxGit.bringToHost(sandbox, "nope", "a".repeat(40))
      ).rejects.toThrow(/has no branch nope/u);
    });

    it("refuses to move a host branch that diverged", async () => {
      const one = await fixture.commit(clone, "One");
      await fixture.commit(host, "Host");
      await sbxCopies();
      await expect(
        sandboxGit.bringToHost(sandbox, "main", one)
      ).rejects.toThrow(/fast-forward/u);
    });
  });

  describe("origin", () => {
    let origin: string;

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
    });

    it("pushes a branch, and compares with origin", async () => {
      const one = await fixture.commit(clone, "One");
      await sbxCopies();
      await expect(branches()).resolves.toMatchObject([
        { name: "main", origin: { ahead: 1, behind: 0 } },
      ]);

      await sandboxGit.push(sandbox, "main", one);
      await expect(fixture.git(origin, "rev-parse", "main")).resolves.toBe(one);
      await expect(branches()).resolves.toMatchObject([
        { name: "main", origin: { ahead: 0, behind: 0, sha: one } },
      ]);
    });

    it("force-pushes only with a lease that still holds", async () => {
      const before = await fixture.git(host, "rev-parse", "origin/main");
      await fixture.commit(clone, "One");
      await fixture.git(clone, "reset", "--quiet", "--hard", "HEAD~1");
      const rewritten = await fixture.commit(clone, "Rewritten");
      await sbxCopies();

      await expect(
        sandboxGit.push(sandbox, "main", rewritten, "b".repeat(40))
      ).rejects.toThrow(/stale info|rejected/u);
      await sandboxGit.push(sandbox, "main", rewritten, before);
      await expect(fixture.git(origin, "rev-parse", "main")).resolves.toBe(
        rewritten
      );
    });

    it("fetches origin on refresh, even when syncing fails", async () => {
      const other = await fixture.clone(origin, "other");
      const pushed = await fixture.commit(other, "Pushed elsewhere");
      await fixture.git(other, "push", "--quiet", "origin", "main");
      await fixture.git(host, "remote", "set-url", "sandbox-s", "/nowhere");

      await expect(sandboxGit.refresh(sandbox)).rejects.toThrow(/nowhere/u);
      await expect(
        fixture.git(host, "rev-parse", "refs/remotes/origin/main")
      ).resolves.toBe(pushed);
    });

    it("refreshes a stopped sandbox by fetching origin only", async () => {
      await sbxCopies();
      await sbxStops();
      await expect(sandboxGit.refresh(sandbox)).resolves.toBeUndefined();
    });
  });

  it("reports a repository it can't read as unknown work, not an error", async () => {
    const broken = createSandboxGit({
      ...createGit(exec),
      refs: () => Promise.reject(new CommandError("bad object")),
    });
    await expect(broken.status(sandbox)).resolves.toMatchObject({
      branches: [],
      error: "bad object",
      work: {
        count: 0,
        unknown: "The Panel can't read the repository: bad object",
      },
    });
  });
});
