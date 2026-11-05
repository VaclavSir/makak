// oxlint-disable no-template-curly-in-string -- env files reference args as ${{ env.args.NAME }}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLifecycle, isLifecycleError, userMessage } from "./lifecycle.ts";
import type { CreateRequest, Lifecycle } from "./lifecycle.ts";
import type { McpLoads } from "./mcp/loads.ts";
import type { SandboxGit, Work } from "./sandbox-git.ts";
import { createSandboxes } from "./sandboxes.ts";
import { createSandboxStore } from "./state.ts";
import type { SandboxStore } from "./state.ts";
import { CommandError } from "./tools/exec.ts";
import { createFakeSbx } from "./tools/index.ts";
import type { EnvSpec, Sandbox, Sbx } from "./tools/index.ts";

const BASE = `schemaVersion: "1"
args:
  sandbox: { required: true }
  project: { required: true, pattern: "/.+" }
  agent: { default: claude, enum: [claude, codex] }
agent: \${{ env.args.agent }}
workspace:
  path: \${{ env.args.project }}
  clone: true
`;

const DOCS = `args:
  docs: { required: true }
additionalWorkspaces:
  - path: \${{ env.args.docs }}
lifecycle:
  preRemove:
    - command: archive \${{ env.args.sandbox }}
`;

type Call = [string, unknown];

/** The fake sbx, recording every change made through it. */
const recordingSbx = () => {
  const fake = createFakeSbx();
  const calls: Call[] = [];
  const sbx: Sbx = {
    ...fake,
    envPlan: (spec) => {
      calls.push(["envPlan", spec]);
      return fake.envPlan(spec);
    },
    envRm: (spec) => {
      calls.push(["envRm", spec]);
      return fake.envRm(spec);
    },
    envRun: (spec) => {
      calls.push(["envRun", spec]);
      return fake.envRun(spec);
    },
    rm: (name) => {
      calls.push(["rm", name]);
      return fake.rm(name);
    },
    start: (name) => {
      calls.push(["start", name]);
      return fake.start(name);
    },
    stop: (name) => {
      calls.push(["stop", name]);
      return fake.stop(name);
    },
  };
  return { calls, sbx };
};

/** Records the sandboxes it syncs, and reports the given work. */
const stubGit = () => {
  const synced: string[] = [];
  const state: { work: Work | undefined } = { work: undefined };
  const git: Pick<SandboxGit, "status" | "sync"> = {
    status: () =>
      Promise.resolve(
        state.work === undefined
          ? undefined
          : {
              branches: [],
              error: undefined,
              hasOrigin: false,
              repo: "/r",
              work: state.work,
            }
      ),
    sync: ({ name }) => {
      synced.push(name);
      return Promise.resolve();
    },
  };
  return { git, state, synced };
};

const commit = (sha: string) => ({ sha, subject: `Commit ${sha}` });

describe(createLifecycle, () => {
  let dir: string;
  let sandboxGit: ReturnType<typeof stubGit>;
  let envDir: string;
  let calls: Call[];
  let sbx: Sbx;
  let store: SandboxStore;
  let lifecycle: Lifecycle;

  const request: CreateRequest = {
    args: { agent: "codex", project: "/p" },
    files: ["00-base.sbxenv.yaml"],
    mcp: [],
    name: "new-one",
  };
  const basePath = () => path.join(envDir, "00-base.sbxenv.yaml");
  const docsPath = () => path.join(envDir, "10-docs.sbxenv.yaml");

  const changes = () => calls.filter(([what]) => what !== "envPlan");

  const existing = async (name: string): Promise<Sandbox> => {
    const sandboxes = await sbx.list();
    const found = sandboxes.find((sandbox) => sandbox.name === name);
    if (found === undefined) {
      throw new Error(`No fake sandbox ${name}`);
    }
    return found;
  };

  const created = async (createRequest = request) => {
    const { hashes } = await lifecycle.planCreate(createRequest);
    return lifecycle.create(createRequest, hashes);
  };

  /** Loads into nothing, recording each; `refuse` names servers to fail. */
  const stubLoads = (refuse: string[] = []) => {
    const loads: string[][] = [];
    const mcp: McpLoads = {
      load: (server, sandbox) => {
        loads.push(["load", server, sandbox]);
        return refuse.includes(server)
          ? Promise.reject(new CommandError(`sbx couldn't load ${server}`))
          : Promise.resolve();
      },
      problems: (servers) =>
        Promise.resolve(
          servers
            .filter((server) => server === "jira")
            .map((server) => `${server} isn't registered with sbx.`)
        ),
      unload: (server, sandbox) => {
        loads.push(["unload", server, sandbox]);
        return Promise.resolve();
      },
    };
    lifecycle = createLifecycle({
      envDir,
      mcp,
      sandboxGit: sandboxGit.git,
      sandboxes: createSandboxes(sbx),
      sbx,
      store,
    });
    return loads;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-lifecycle-"));
    envDir = path.join(dir, "envs");
    await mkdir(envDir);
    await writeFile(basePath(), BASE);
    await writeFile(docsPath(), DOCS);
    ({ calls, sbx } = recordingSbx());
    store = createSandboxStore(path.join(dir, "state"));
    sandboxGit = stubGit();
    lifecycle = createLifecycle({
      envDir,
      now: () => new Date("2026-10-19T08:00:00.000Z"),
      sandboxGit: sandboxGit.git,
      sandboxes: createSandboxes(sbx),
      sbx,
      store,
    });
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  describe("planCreate", () => {
    it("plans with absolute paths, the given args and the name as the sandbox arg", async () => {
      const plan = await lifecycle.planCreate({
        ...request,
        args: { ...request.args, docs: "/docs" },
        files: ["10-docs.sbxenv.yaml", "00-base.sbxenv.yaml"],
      });

      const spec: EnvSpec = {
        args: {
          agent: "codex",
          docs: "/docs",
          project: "/p",
          sandbox: "new-one",
        },
        // Directory order: the base first.
        files: [basePath(), docsPath()],
        name: "new-one",
      };
      expect(plan.spec).toStrictEqual(spec);
      expect(plan.hashes).toHaveLength(2);
      expect(plan.output).toContain("+ sandbox: new-one");
      expect(plan.warnings).toStrictEqual([
        expect.stringContaining("/docs is writable"),
      ]);
      expect(calls).toStrictEqual([["envPlan", spec]]);
    });

    it("leaves empty optional args to the files' defaults", async () => {
      const plan = await lifecycle.planCreate({
        ...request,
        args: { agent: "", project: "/p" },
      });
      expect(plan.spec.args).toStrictEqual({
        project: "/p",
        sandbox: "new-one",
      });
    });

    it.each([
      ["a bad name", { name: "-x" }, /must start with a letter/u],
      ["a taken name", { name: "feature-a" }, /already exists/u],
      ["no files", { files: [] }, /at least one env file/u],
      [
        "a path",
        { files: ["../00-base.sbxenv.yaml"] },
        /not an env file name/u,
      ],
      [
        "a missing file",
        { files: ["99-gone.sbxenv.yaml"] },
        /no longer exists/u,
      ],
      [
        "a missing required arg",
        { args: { agent: "codex" } },
        /project is required/u,
      ],
      [
        "a value outside the enum",
        { args: { agent: "x", project: "/p" } },
        /agent must be one of claude, codex/u,
      ],
      [
        "a value not matching the pattern",
        { args: { project: "p" } },
        /project must match/u,
      ],
      [
        "an undeclared arg",
        { args: { other: "1", project: "/p" } },
        /don't declare the arg other/u,
      ],
    ])("refuses %s", async (_, change, message) => {
      await expect(
        lifecycle.planCreate({ ...request, ...change })
      ).rejects.toThrow(message);
      expect(calls).toStrictEqual([]);
    });
  });

  describe("create", () => {
    it("applies the plan and records how", async () => {
      const sandbox = await created();

      const spec = {
        args: { agent: "codex", project: "/p", sandbox: "new-one" },
        files: [basePath()],
        name: "new-one",
      };
      expect(sandbox).toMatchObject({ name: "new-one", status: "running" });
      expect(changes()).toStrictEqual([["envRun", spec]]);
      await expect(store.get(sandbox.id)).resolves.toStrictEqual({
        env: { ...spec, createdAt: "2026-10-19T08:00:00.000Z" },
        mcp: [],
        notes: "",
      });
    });

    it("refuses to apply files that changed since the plan", async () => {
      const { hashes } = await lifecycle.planCreate(request);
      await writeFile(basePath(), `${BASE}\nenv: { EXTRA: "1" }\n`);

      await expect(lifecycle.create(request, hashes)).rejects.toThrow(
        /changed since the plan was shown \(00-base.sbxenv.yaml\)/u
      );
      expect(changes()).toStrictEqual([]);
    });

    it("refuses hashes for another set of files", async () => {
      const { hashes } = await lifecycle.planCreate(request);
      await expect(
        lifecycle.create(
          {
            ...request,
            args: { ...request.args, docs: "/d" },
            files: ["00-base.sbxenv.yaml", "10-docs.sbxenv.yaml"],
          },
          hashes
        )
      ).rejects.toThrow(/changed since the plan was shown/u);
    });

    it("refuses a name taken since the plan", async () => {
      const { hashes } = await lifecycle.planCreate(request);
      await sbx.envRun({ args: {}, files: [basePath()], name: "new-one" });

      await expect(lifecycle.create(request, hashes)).rejects.toThrow(
        /already exists/u
      );
    });

    it("runs one create per name at a time", async () => {
      const { hashes } = await lifecycle.planCreate(request);
      const results = await Promise.allSettled([
        lifecycle.create(request, hashes),
        lifecycle.create(request, hashes),
      ]);
      expect(results.map(({ status }) => status).toSorted()).toStrictEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(changes()).toHaveLength(1);
    });

    it("reports the create failure, not a failure to record it", async () => {
      let ran = false;
      const failing: Sbx = {
        ...sbx,
        envRun: () => {
          ran = true;
          return Promise.reject(new CommandError("image pull failed"));
        },
        // The daemon is struggling too, once the create has started.
        list: () =>
          ran
            ? Promise.reject(new CommandError("sbx ls timed out"))
            : sbx.list(),
      };
      const { hashes } = await lifecycle.planCreate(request);
      lifecycle = createLifecycle({
        envDir,
        sandboxGit: sandboxGit.git,
        sandboxes: createSandboxes(failing),
        sbx: failing,
        store,
      });

      await expect(lifecycle.create(request, hashes)).rejects.toThrow(
        "image pull failed"
      );
    });

    it("still records a sandbox that sbx created before failing", async () => {
      const failing: Sbx = {
        ...sbx,
        envRun: async (spec) => {
          await sbx.envRun(spec);
          throw new CommandError("postCreate failed");
        },
      };
      const sandboxes = createSandboxes(failing);
      lifecycle = createLifecycle({
        envDir,
        sandboxGit: sandboxGit.git,
        sandboxes,
        sbx: failing,
        store,
      });

      const { hashes } = await lifecycle.planCreate(request);
      await expect(lifecycle.create(request, hashes)).rejects.toThrow(
        "postCreate failed"
      );
      const sandbox = await sandboxes.find("new-one");
      const record = await store.get(sandbox?.id ?? "");
      expect(record.env?.name).toBe("new-one");
    });
  });

  describe("start", () => {
    it("plans and replays the recorded env for a managed sandbox", async () => {
      const sandbox = await created();
      await lifecycle.stop(sandbox);
      calls.length = 0;

      const plan = await lifecycle.planStart(sandbox);
      await lifecycle.start(sandbox, plan.hashes);

      const spec = {
        args: { agent: "codex", project: "/p", sandbox: "new-one" },
        files: [basePath()],
        name: "new-one",
      };
      expect(calls).toStrictEqual([
        ["envPlan", spec],
        ["envRun", spec],
      ]);
    });

    it("refuses files that changed since the plan", async () => {
      const sandbox = await created();
      const { hashes } = await lifecycle.planStart(sandbox);
      await writeFile(basePath(), `${BASE}\n# changed\n`);

      await expect(lifecycle.start(sandbox, hashes)).rejects.toThrow(
        /changed since the plan/u
      );
    });

    it("starts a managed sandbox whose env files are gone with sbx run", async () => {
      const sandbox = await created();
      await lifecycle.stop(sandbox);
      await rm(basePath());

      await expect(lifecycle.planStart(sandbox)).rejects.toThrow(
        /no longer exists/u
      );
      await expect(lifecycle.start(sandbox, ["stale"])).rejects.toThrow(
        /Reload the page/u
      );
      await lifecycle.start(sandbox, []);
      expect(changes().at(-1)).toStrictEqual(["start", "new-one"]);
    });

    it("starts an unmanaged sandbox with sbx run, without a plan", async () => {
      const target = {
        id: "00000000-0000-4000-8000-000000000003",
        name: "old-experiment",
      };
      await expect(lifecycle.planStart(target)).rejects.toThrow(/not managed/u);
      await lifecycle.start(target, []);
      expect(changes()).toStrictEqual([["start", "old-experiment"]]);
    });
  });

  describe("stop", () => {
    it("stops the sandbox the page showed", async () => {
      await lifecycle.stop({
        id: "00000000-0000-4000-8000-000000000002",
        name: "feature-a",
      });
      expect(changes()).toStrictEqual([["stop", "feature-a"]]);
    });

    it("copies the branches first, and stops even if that fails", async () => {
      const sandbox = await existing("feature-a");
      lifecycle = createLifecycle({
        envDir,
        sandboxGit: {
          ...sandboxGit.git,
          sync: (target) => {
            // Copied while it still runs.
            expect(changes()).toStrictEqual([]);
            return sandboxGit.git.sync(target);
          },
        },
        sandboxes: createSandboxes(sbx),
        sbx,
        store,
      });
      await lifecycle.stop(sandbox);
      expect(sandboxGit.synced).toStrictEqual(["feature-a"]);

      lifecycle = createLifecycle({
        envDir,
        sandboxGit: {
          ...sandboxGit.git,
          sync: () => Promise.reject(new Error("daemon down")),
        },
        sandboxes: createSandboxes(sbx),
        sbx,
        store,
      });
      await sbx.start("feature-a");
      calls.length = 0;
      await lifecycle.stop(sandbox);
      expect(changes()).toStrictEqual([["stop", "feature-a"]]);
    });

    it("refuses when the name now belongs to another sandbox", async () => {
      await expect(
        lifecycle.stop({ id: "another", name: "feature-a" })
      ).rejects.toThrow(/replaced by a new sandbox/u);
      expect(changes()).toStrictEqual([]);
    });
  });

  describe("remove", () => {
    it("removes a managed sandbox with its env, and keeps the record", async () => {
      const sandbox = await created({
        ...request,
        args: { ...request.args, docs: "/d" },
        files: ["00-base.sbxenv.yaml", "10-docs.sbxenv.yaml"],
      });
      calls.length = 0;

      const { removal, warnings } = await lifecycle.inspect(sandbox);
      expect(removal).toMatchObject({
        hostCommands: ["archive new-one"],
        method: "env",
      });
      expect(warnings).toStrictEqual([
        expect.stringContaining("/d is writable"),
      ]);

      await lifecycle.remove(sandbox, "new-one", removal.hashes);
      expect(calls).toStrictEqual([
        [
          "envRm",
          {
            args: {
              agent: "codex",
              docs: "/d",
              project: "/p",
              sandbox: "new-one",
            },
            files: [basePath(), docsPath()],
            name: "new-one",
          },
        ],
      ]);
      const record = await store.get(sandbox.id);
      expect(record.env?.name).toBe("new-one");
    });

    it("needs the name typed to confirm", async () => {
      const sandbox = await created();
      const { removal } = await lifecycle.inspect(sandbox);
      await expect(
        lifecycle.remove(sandbox, "new-on", removal.hashes)
      ).rejects.toThrow(/Type the sandbox's name, new-one/u);
      expect(changes()).toHaveLength(1);
    });

    it("refuses env files that changed since the confirmation was shown", async () => {
      const sandbox = await created();
      const { removal } = await lifecycle.inspect(sandbox);
      await writeFile(
        basePath(),
        `${BASE}\nlifecycle: { preRemove: [{ command: "rm -rf ~" }] }\n`
      );

      await expect(
        lifecycle.remove(sandbox, "new-one", removal.hashes)
      ).rejects.toThrow(/changed since/u);
    });

    it("falls back to sbx rm when the env files are gone, if the confirmation said so", async () => {
      const sandbox = await created();
      const before = await lifecycle.inspect(sandbox);
      await rm(basePath());

      await expect(
        lifecycle.remove(sandbox, "new-one", before.removal.hashes)
      ).rejects.toThrow(/can't be read any more/u);

      const { envProblem, removal } = await lifecycle.inspect(sandbox);
      expect(envProblem).toContain("no longer exists");
      expect(removal).toMatchObject({ hashes: [], method: "rm" });
      await lifecycle.remove(sandbox, "new-one", removal.hashes);
      expect(changes().at(-1)).toStrictEqual(["rm", "new-one"]);
    });

    it("asks for a reload, not a plan, when the files changed since the page loaded", async () => {
      const sandbox = await created();
      const { removal } = await lifecycle.inspect(sandbox);
      await writeFile(basePath(), `${BASE}\n# edited\n`);

      await expect(
        lifecycle.remove(sandbox, "new-one", removal.hashes)
      ).rejects.toThrow(
        "The env files changed since this page was loaded (00-base.sbxenv.yaml). Reload the page to see what removing it runs now."
      );
    });

    it("reports a removal that worked even if forgetting the notes fails", async () => {
      const target = {
        id: "00000000-0000-4000-8000-000000000003",
        name: "old-experiment",
      };
      const failingStore: SandboxStore = {
        ...store,
        forget: () => Promise.reject(new Error("read-only")),
      };
      lifecycle = createLifecycle({
        envDir,
        sandboxGit: sandboxGit.git,
        sandboxes: createSandboxes(sbx),
        sbx,
        store: failingStore,
      });

      await lifecycle.remove(target, "old-experiment", []);
      expect(changes()).toStrictEqual([["rm", "old-experiment"]]);
    });

    describe("with Git work", () => {
      it("lists it, and copies the latest commits first", async () => {
        const sandbox = await existing("feature-a");
        sandboxGit.state.work = {
          commits: [commit("a")],
          count: 1,
          unknown: undefined,
        };
        const { removal } = await lifecycle.inspect(sandbox);
        expect(removal.work).toStrictEqual(sandboxGit.state.work);

        await lifecycle.remove(sandbox, "feature-a", []);
        expect(sandboxGit.synced).toStrictEqual(["feature-a"]);
        expect(changes()).toStrictEqual([["rm", "feature-a"]]);
      });

      it("removes even if copying fails", async () => {
        const sandbox = await existing("feature-a");
        lifecycle = createLifecycle({
          envDir,
          sandboxGit: {
            ...sandboxGit.git,
            sync: () => Promise.reject(new Error("daemon down")),
          },
          sandboxes: createSandboxes(sbx),
          sbx,
          store,
        });
        await lifecycle.remove(sandbox, "feature-a", []);
        expect(changes()).toStrictEqual([["rm", "feature-a"]]);
      });
    });

    it("removes an unmanaged sandbox with sbx rm, and its record", async () => {
      const target = await existing("old-experiment");
      await store.setNotes(target.id, "notes");
      const { env, removal } = await lifecycle.inspect(target);
      expect(env).toBeUndefined();
      expect(removal).toStrictEqual({
        hasNotes: true,
        hashes: [],
        hostCommands: [],
        method: "rm",
        work: undefined,
      });

      await lifecycle.remove(target, "old-experiment", []);
      expect(changes()).toStrictEqual([["rm", "old-experiment"]]);
      await expect(store.list()).resolves.toStrictEqual({});
    });
  });

  describe("MCP servers", () => {
    it("loads the chosen servers once the sandbox runs, and records them", async () => {
      const loads = stubLoads();
      const sandbox = await created({
        ...request,
        mcp: ["linear", "gitlab", "linear"],
      });

      expect(loads).toStrictEqual([
        ["load", "linear", "new-one"],
        ["load", "gitlab", "new-one"],
      ]);
      const { mcp } = await lifecycle.inspect(sandbox);
      expect(mcp).toStrictEqual(["gitlab", "linear"]);
    });

    it("plans no sandbox with a server that can't be loaded", async () => {
      const loads = stubLoads();
      await expect(
        lifecycle.planCreate({ ...request, mcp: ["jira"] })
      ).rejects.toThrow("jira isn't registered with sbx.");
      expect(loads).toStrictEqual([]);
    });

    it("keeps a sandbox whose servers didn't all load, and says which", async () => {
      stubLoads(["gitlab"]);
      await expect(
        created({ ...request, mcp: ["gitlab", "linear"] })
      ).rejects.toThrow(
        "new-one was created, but not every MCP server could be loaded into it:\nsbx couldn't load gitlab\nLoad them from its page once that's fixed."
      );
      const sandbox = await existing("new-one");
      await expect(store.get(sandbox.id)).resolves.toMatchObject({
        mcp: ["linear"],
      });
    });

    it("loads and unloads one server, for the sandbox the page showed", async () => {
      const loads = stubLoads();
      const sandbox = await existing("claude-makak");
      await lifecycle.loadMcp(sandbox, "linear");
      await expect(store.get(sandbox.id)).resolves.toMatchObject({
        mcp: ["linear"],
      });
      await lifecycle.unloadMcp(sandbox, "linear");
      await expect(store.get(sandbox.id)).resolves.toMatchObject({ mcp: [] });

      await expect(lifecycle.loadMcp(sandbox, "jira")).rejects.toThrow(
        "jira isn't registered with sbx."
      );
      await expect(
        lifecycle.loadMcp({ ...sandbox, id: "other" }, "linear")
      ).rejects.toThrow(/replaced by a new sandbox/u);
      expect(loads).toStrictEqual([
        ["load", "linear", "claude-makak"],
        ["unload", "linear", "claude-makak"],
      ]);
    });

    it("gives no servers without the Panel's MCP", async () => {
      await expect(
        lifecycle.planCreate({ ...request, mcp: ["linear"] })
      ).rejects.toThrow("The Panel has no MCP servers to give sandboxes.");
    });
  });
});

describe(userMessage, () => {
  it("passes on the errors meant for the user, not bugs", () => {
    expect(userMessage(new CommandError("sbx failed"))).toBe("sbx failed");
    expect(userMessage(new TypeError("bug"))).toBeUndefined();
  });

  it("recognizes lifecycle errors by name", () => {
    const error = new Error("x");
    error.name = "LifecycleError";
    expect(isLifecycleError(error)).toBeTruthy();
  });
});
