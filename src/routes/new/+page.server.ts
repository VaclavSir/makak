import path from "node:path";

import { fail, redirect } from "@sveltejs/kit";
import * as z from "zod";

import { SANDBOX_ARG } from "#lib/env-files.ts";
import {
  attempt,
  hashesSchema,
  INCOMPLETE,
  jsonField,
} from "#lib/server/actions.ts";
import { getPanelContext } from "#server/context.ts";
import { listEnvFiles } from "#server/envs.ts";
import type { CreateRequest } from "#server/lifecycle.ts";

import type { Actions, PageServerLoad } from "./$types";

const ARG_FIELD = "arg:";

const requestSchema = z.object({
  args: z.record(z.string(), z.string()),
  files: z.array(z.string()),
  name: z.string(),
});

/** The create form as a request: checked files, name and `arg:` fields. */
const readForm = (form: FormData): CreateRequest => {
  const args: Record<string, string> = {};
  for (const [field, value] of form) {
    if (field.startsWith(ARG_FIELD) && typeof value === "string") {
      args[field.slice(ARG_FIELD.length)] = value.trim();
    }
  }
  const name = form.get("name");
  return {
    args,
    files: form.getAll("file").filter((file) => typeof file === "string"),
    name: typeof name === "string" ? name.trim() : "",
  };
};

export const load: PageServerLoad = async ({ url }) => {
  const { config, sandboxes, store } = getPanelContext();
  const files = await listEnvFiles(config.envDir);
  const names = new Set(files.map(({ name }) => name));

  // A base layer such as 00-base.sbxenv.yaml starts out checked.
  let initial: CreateRequest = {
    args: {},
    files: [...names].filter((name) => name.startsWith("00-")),
    name: "",
  };
  let from: { missing: string[]; name: string } | undefined;

  const fromId = url.searchParams.get("from");
  if (fromId !== null) {
    const { env } = await store.get(fromId);
    if (env !== undefined) {
      const recorded = env.files.map((file) => ({
        inEnvDir: path.dirname(file) === config.envDir,
        name: path.basename(file),
      }));
      const { [SANDBOX_ARG]: _name, ...args } = env.args;
      // The old name stays free once the sandbox is removed.
      const taken = (await sandboxes.find(env.name)) !== undefined;
      initial = {
        args,
        files: recorded
          .filter(({ inEnvDir, name }) => inEnvDir && names.has(name))
          .map(({ name }) => name),
        name: taken ? "" : env.name,
      };
      from = {
        missing: env.files.filter(
          (_file, index) =>
            !(
              recorded[index]?.inEnvDir === true &&
              names.has(recorded[index].name)
            )
        ),
        name: env.name,
      };
    }
  }

  return {
    envDir: config.envDir,
    files: files.map(({ args, error, name }) => ({ args, error, name })),
    from,
    initial,
  };
};

export const actions: Actions = {
  create: async ({ request }) => {
    const form = await request.formData();
    const createRequest = jsonField(requestSchema, form.get("request"));
    const hashes = jsonField(hashesSchema, form.get("hashes"));
    if (createRequest === undefined || hashes === undefined) {
      return fail(400, INCOMPLETE);
    }
    const result = await attempt(() =>
      getPanelContext().lifecycle.create(createRequest, hashes)
    );
    if (!result.ok) {
      return result.failure;
    }
    redirect(303, `/sandboxes/${encodeURIComponent(result.value.name)}`);
  },

  plan: async ({ request }) => {
    const createRequest = readForm(await request.formData());
    const result = await attempt(() =>
      getPanelContext().lifecycle.planCreate(createRequest)
    );
    if (!result.ok) {
      return result.failure;
    }
    const { hashes, output, warnings } = result.value;
    return { plan: { hashes, output, request: createRequest, warnings } };
  },
};
