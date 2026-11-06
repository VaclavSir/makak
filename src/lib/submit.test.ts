import type { ActionResult } from "$app/forms";
import { describe, expect, it } from "vitest";

import { FAILED, failureMessage, idle, submitting } from "./submit.ts";
import type { Answer } from "./submit.ts";

/** Submits through `submitting`'s handler and answers with `result`. */
const submit = async (
  handler: ReturnType<typeof submitting>,
  result: ActionResult
) => {
  const afterwards = await handler({} as Parameters<typeof handler>[0]);
  return async () => {
    if (typeof afterwards === "function") {
      await afterwards({
        result,
        update: async () => {},
      } as unknown as Answer);
    }
  };
};

describe(submitting, () => {
  it("is busy until the answer, then hands a success on", async () => {
    const form = idle<string>();
    form.message = "old";
    const answers: string[] = [];
    const answer = await submit(
      submitting(form, "save", ({ result }) => {
        answers.push(result.type);
      }),
      { data: { saved: true }, location: "/", status: 200, type: "success" }
    );
    expect(form).toStrictEqual({ busy: "save", failed: false, message: "" });
    await answer();
    expect(form.busy).toBeUndefined();
    expect(answers).toStrictEqual(["success"]);
  });

  it("shows a failure's message and stops there", async () => {
    const form = idle();
    let handed = false;
    const answer = await submit(
      submitting(form, true, () => {
        handed = true;
      }),
      {
        data: { message: "No such sandbox." },
        location: "/",
        status: 400,
        type: "failure",
      }
    );
    await answer();
    expect(form).toStrictEqual({
      busy: undefined,
      failed: true,
      message: "No such sandbox.",
    });
    expect(handed).toBeFalsy();
  });
});

describe(failureMessage, () => {
  it("falls back when the action gave no message", () => {
    expect(
      failureMessage({ location: "/", status: 500, type: "failure" })
    ).toBe(FAILED);
  });
});
