// oxlint-disable no-template-curly-in-string -- env files reference args as ${{ env.args.NAME }}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { argSpecs } from "../lib/env-files.ts";
import {
  effectiveArgs,
  envWarnings,
  listEnvFiles,
  mergeEnvFiles,
  preRemoveCommands,
  readEnvFile,
  substituteArgs,
} from "./envs.ts";

const EXAMPLES = fileURLToPath(new URL("../../examples/envs", import.meta.url));

describe("env files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-envs-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  describe(listEnvFiles, () => {
    it("lists *.sbxenv.yaml files, sorted by name", async () => {
      await writeFile(path.join(dir, "20-web.sbxenv.yaml"), "ports: []\n");
      await writeFile(
        path.join(dir, "00-base.sbxenv.yaml"),
        'schemaVersion: "1"\n'
      );
      await writeFile(path.join(dir, "notes.md"), "# not an env\n");
      await mkdir(path.join(dir, "kits.sbxenv.yaml.d"));

      const files = await listEnvFiles(dir);
      expect(files.map(({ name }) => name)).toStrictEqual([
        "00-base.sbxenv.yaml",
        "20-web.sbxenv.yaml",
      ]);
      expect(files[0]).toMatchObject({
        content: { schemaVersion: "1" },
        error: undefined,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        path: path.join(dir, "00-base.sbxenv.yaml"),
      });
    });

    it("finds none in a missing directory", async () => {
      await expect(listEnvFiles(path.join(dir, "none"))).resolves.toStrictEqual(
        []
      );
    });
  });

  describe(readEnvFile, () => {
    it.each([
      ["invalid YAML", "a: [b\n", /Not valid YAML/u],
      ["a list", "- a\n", /Not a YAML mapping/u],
      ["empty", "", /Not a YAML mapping/u],
    ])("reports a file that is %s", async (_, text, error) => {
      const file = path.join(dir, "x.sbxenv.yaml");
      await writeFile(file, text);
      await expect(readEnvFile(file)).resolves.toMatchObject({
        content: undefined,
        error: expect.stringMatching(error),
      });
    });

    it("reports a missing file", async () => {
      await expect(
        readEnvFile(path.join(dir, "gone.sbxenv.yaml"))
      ).resolves.toMatchObject({
        error: "The file no longer exists.",
        hash: "",
      });
    });

    it("hashes the content, so a change shows", async () => {
      const file = path.join(dir, "x.sbxenv.yaml");
      await writeFile(file, "env: {A: '1'}\n");
      const before = await readEnvFile(file);
      await writeFile(file, "env: {A: '2'}\n");
      const after = await readEnvFile(file);
      expect(after.hash).not.toBe(before.hash);
    });

    it("reads arg references as text", async () => {
      const file = path.join(dir, "x.sbxenv.yaml");
      await writeFile(file, "workspace:\n  path: ${{ env.args.project }}\n");
      await expect(readEnvFile(file)).resolves.toMatchObject({
        content: { workspace: { path: "${{ env.args.project }}" } },
      });
    });
  });
});

describe(substituteArgs, () => {
  it("substitutes declared args, and keeps escaped and unknown references", () => {
    expect(
      substituteArgs(
        "${{ env.args.project }}/src ${{env.args.dev_port}} $${{ env.args.project }} ${{ env.args.nope }} ${{ env.fileDir }}",
        { dev_port: "8000", project: "/p" }
      )
    ).toBe(
      "/p/src 8000 ${{ env.args.project }} ${{ env.args.nope }} ${{ env.fileDir }}"
    );
  });
});

describe(effectiveArgs, () => {
  it("fills in defaults under the values given", () => {
    const env = {
      args: {
        cpus: { default: 4 },
        memory: { default: "8g" },
        project: { required: true },
      },
    };
    expect(effectiveArgs(env, { memory: "16g", project: "/p" })).toStrictEqual({
      cpus: "4",
      memory: "16g",
      project: "/p",
    });
  });
});

describe(envWarnings, () => {
  it("warns about a workspace that is not a clone", () => {
    expect(envWarnings({ workspace: "/p" }, {})).toStrictEqual([
      expect.stringContaining("/p is mounted directly"),
    ]);
    expect(
      envWarnings(
        { workspace: { clone: false, path: "${{ env.args.project }}" } },
        { project: "/p" }
      )
    ).toStrictEqual([expect.stringContaining("/p is mounted directly")]);
  });

  it("warns about writable additional workspaces", () => {
    expect(
      envWarnings(
        {
          additionalWorkspaces: [
            { path: "/docs", readOnly: true },
            { path: "/lib" },
            { path: "/other", readOnly: false },
          ],
        },
        {}
      )
    ).toStrictEqual([
      expect.stringContaining("/lib is writable"),
      expect.stringContaining("/other is writable"),
    ]);
  });

  it("reads settings given as arg references", () => {
    const env = {
      additionalWorkspaces: [{ path: "/docs", readOnly: "${{ env.args.ro }}" }],
      workspace: { clone: "${{ env.args.clone }}", path: "/p" },
    };
    expect(envWarnings(env, { clone: "true", ro: "true" })).toStrictEqual([]);
    expect(envWarnings(env, { clone: "false", ro: "false" })).toHaveLength(2);
  });

  it("warns about env files the sandbox can write", () => {
    expect(
      envWarnings({ sandboxOptions: { writableEnvFiles: true } }, {})
    ).toStrictEqual([expect.stringContaining("writable from the sandbox")]);
  });

  it("has nothing to say about a sandbox without mounts", () => {
    expect(envWarnings({ agent: "claude" }, {})).toStrictEqual([]);
  });
});

describe(preRemoveCommands, () => {
  it("lists the commands, with args substituted", () => {
    expect(
      preRemoveCommands(
        {
          lifecycle: {
            initialize: [{ command: "mkdir -p x" }],
            preRemove: [
              { command: "archive ${{ env.args.sandbox }}", name: "Archive" },
              "bad",
            ],
          },
        },
        { sandbox: "feature-a" }
      )
    ).toStrictEqual(["archive feature-a"]);
  });
});

describe("the example env files", () => {
  it("parse, follow the workflow, and declare the sandbox arg", async () => {
    const files = await listEnvFiles(EXAMPLES);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(({ error }) => error !== undefined)).toStrictEqual([]);

    const merged = mergeEnvFiles(files);
    const specs = argSpecs(merged);
    expect(specs.sandbox?.required).toBeTruthy();
    // Every arg is declared once: enums of an arg declared twice concatenate.
    const declared = files.flatMap(({ args }) => Object.keys(args as object));
    expect(new Set(declared).size).toBe(declared.length);

    const args = effectiveArgs(merged, {
      project: "/p",
      reference: "/r",
      sandbox: "s",
    });
    expect(envWarnings(merged, args)).toStrictEqual([]);
  });
});
