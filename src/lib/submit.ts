import type { ActionResult, SubmitFunction } from "$app/forms";

// How the Panel's forms submit with `use:enhance`: say which is busy, and
// show a failure's message by the form rather than in the page.

/** Shown when a failed action gave no message of its own. */
export const FAILED = "It didn't work.";

/** A form's state, kept by `submitting`. Make it with `$state(idle())`. */
export interface FormState<T = true> {
  /** What is being submitted, so its button can say so; undefined when idle. */
  busy: T | undefined;
  /** Whether `message` is a failure. */
  failed: boolean;
  /** The last failure, or what the form shows of a success. */
  message: string;
}

export const idle = <T = true>(): FormState<T> => ({
  busy: undefined,
  failed: false,
  message: "",
});

/** What `use:enhance` hands over once the action answers. */
export type Answer = Parameters<
  Exclude<Awaited<ReturnType<SubmitFunction>>, void>
>[0];

/** The message a failed action answered with. */
export const failureMessage = (
  result: Extract<ActionResult, { type: "failure" }>
): string => String(result.data?.message ?? FAILED);

/**
 * Submits a form as `what`, keeping its state in `form`. A failure shows its
 * message and ends there; any other answer goes to `then`.
 */
export const submitting =
  <T>(
    form: FormState<T>,
    what: T,
    then: (answer: Answer) => Promise<void> | void
  ): SubmitFunction =>
  () => {
    form.busy = what;
    form.message = "";
    return async (answer) => {
      form.busy = undefined;
      if (answer.result.type === "failure") {
        form.failed = true;
        form.message = failureMessage(answer.result);
        return;
      }
      form.failed = false;
      await then(answer);
    };
  };
