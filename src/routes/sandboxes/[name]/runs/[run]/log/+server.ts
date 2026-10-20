import { error as httpError } from "@sveltejs/kit";

import { RUN_ID } from "#lib/runs.ts";
import { findSandbox } from "#lib/server/sandbox.ts";
import { getPanelContext } from "#server/context.ts";
import { userMessage } from "#server/lifecycle.ts";

import type { RequestHandler } from "./$types";

/**
 * A run's log, as raw bytes, from the byte offset `from`. With `follow=1`,
 * the response stays open until the run ends, or the browser goes away.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
  const sandbox = await findSandbox(params.name);
  if (sandbox.status !== "running") {
    httpError(409, `${sandbox.name} isn't running, so its runs can't be read.`);
  }
  if (!RUN_ID.test(params.run)) {
    httpError(404, "No such run.");
  }
  const offset = Number(url.searchParams.get("from") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) {
    httpError(400, "`from` must be a byte offset.");
  }
  const reader = getPanelContext()
    .sandboxRuns.log(sandbox, params.run, {
      follow: url.searchParams.get("follow") === "1",
      offset,
      signal: request.signal,
    })
    .getReader();
  // The first chunk decides the status: a helper that fails at once, such as
  // for a run that doesn't exist, is an error, not an empty log.
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await reader.read();
  } catch (error) {
    httpError(502, userMessage(error) ?? "Can't read the log.");
  }
  const body = new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      await reader.cancel(reason);
    },
    pull: async (controller) => {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    start: (controller) => {
      if (first.done) {
        controller.close();
      } else {
        controller.enqueue(first.value);
      }
    },
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      // The bytes are the command's output, never a page.
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
    },
  });
};
