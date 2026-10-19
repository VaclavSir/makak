import { describe, expect, it } from "vitest";

import {
  argError,
  argPattern,
  argSpecs,
  mergeEnv,
  nameError,
} from "./env-files.ts";

describe(mergeEnv, () => {
  it("merges maps by key, concatenates lists and lets later scalars win", () => {
    expect(
      mergeEnv([
        {
          env: { A: "1", B: "2" },
          ports: [{ sandbox: 1 }],
          sandboxOptions: { cpus: 4 },
        },
        {
          env: { B: "3" },
          ports: [{ sandbox: 2 }],
          sandboxOptions: { cpus: 8, memory: "8g" },
        },
      ])
    ).toStrictEqual({
      env: { A: "1", B: "3" },
      ports: [{ sandbox: 1 }, { sandbox: 2 }],
      sandboxOptions: { cpus: 8, memory: "8g" },
    });
  });

  it("replaces a value of another kind", () => {
    expect(
      mergeEnv([
        { workspace: "/a" },
        { workspace: { clone: true, path: "/b" } },
      ])
    ).toStrictEqual({ workspace: { clone: true, path: "/b" } });
  });

  it("keeps keys that name Object properties as plain keys", () => {
    const later = JSON.parse(
      '{"args": {"constructor": {"default": "x"}, "__proto__": {"default": "y"}}}'
    ) as unknown;
    const merged = mergeEnv([{ args: { toString: { default: "z" } } }, later]);
    expect(Object.keys(argSpecs(merged))).toStrictEqual([
      "toString",
      "constructor",
      "__proto__",
    ]);
    expect(Object.getPrototypeOf((merged as { args: object }).args)).toBe(
      Object.prototype
    );
  });

  it("does not change its inputs", () => {
    const base = { env: { A: "1" } };
    mergeEnv([base, { env: { A: "2" } }]);
    expect(base).toStrictEqual({ env: { A: "1" } });
  });
});

describe(argSpecs, () => {
  it("reads declarations, turning scalars into text", () => {
    expect(
      argSpecs({
        args: {
          cpus: { default: 4, pattern: "[0-9]+" },
          memory: { default: "8g", enum: ["4g", "8g"] },
          project: { description: "Project", required: true },
        },
      })
    ).toStrictEqual({
      cpus: {
        default: "4",
        description: undefined,
        enum: undefined,
        pattern: "[0-9]+",
        required: false,
      },
      memory: {
        default: "8g",
        description: undefined,
        enum: ["4g", "8g"],
        pattern: undefined,
        required: false,
      },
      project: {
        default: undefined,
        description: "Project",
        enum: undefined,
        pattern: undefined,
        required: true,
      },
    });
  });

  it("concatenates enums declared in two files, as sbx does", () => {
    const merged = mergeEnv([
      { args: { agent: { enum: ["claude"] } } },
      { args: { agent: { enum: ["codex"] } } },
    ]);
    expect(argSpecs(merged).agent?.enum).toStrictEqual(["claude", "codex"]);
  });

  it.each([
    ["no args", { agent: "claude" }],
    ["args that are not a map", { args: ["a"] }],
    ["not a map", "text"],
  ])("finds none in %s", (_, env) => {
    expect(argSpecs(env)).toStrictEqual({});
  });
});

describe(argError, () => {
  const spec = { required: false };

  it("requires a value only for required args", () => {
    expect(argError("project", { required: true }, "")).toBe(
      "project is required."
    );
    expect(argError("project", spec, "")).toBeUndefined();
  });

  it("checks enums", () => {
    expect(argError("memory", { ...spec, enum: ["4g", "8g"] }, "2g")).toBe(
      "memory must be one of 4g, 8g."
    );
    expect(
      argError("memory", { ...spec, enum: ["4g", "8g"] }, "8g")
    ).toBeUndefined();
  });

  it("matches patterns against the whole value", () => {
    const cpus = { ...spec, pattern: "[0-9]+" };
    expect(argError("cpus", cpus, "4")).toBeUndefined();
    expect(argError("cpus", cpus, "4 cpus")).toBe("cpus must match [0-9]+.");
  });

  it("leaves patterns JavaScript can't read to sbx", () => {
    expect(argPattern("(?P<x>a)")).toBeUndefined();
    expect(
      argError("x", { ...spec, pattern: "(?P<x>a)" }, "b")
    ).toBeUndefined();
  });
});

describe(nameError, () => {
  it.each(["feature-a", "claude-Brump", "a.b_c", "x"])("accepts %s", (name) => {
    expect(nameError(name)).toBeUndefined();
  });

  it.each(["", "-x", "--force", "a b", "a/b", "x".repeat(64)])(
    "refuses %j",
    (name) => {
      expect(nameError(name)).toBeDefined();
    }
  );
});
