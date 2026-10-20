import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAutosave } from "./autosave.ts";
import type { AutosaveStatus } from "./autosave.ts";

const DELAY = 1000;

type Save = (value: string) => Promise<void>;

const setup = (save = vi.fn<Save>(async () => {})) => {
  const statuses: string[] = [];
  const autosave = createAutosave({
    delay: DELAY,
    initial: "a",
    onstatus: (status: AutosaveStatus, message?: string) => {
      statuses.push(message === undefined ? status : `${status}: ${message}`);
    },
    save,
  });
  return { autosave, save, statuses };
};

/** A save that waits until `finish` is called. */
const deferredSave = () => {
  const finishes: (() => void)[] = [];
  const save = vi.fn<Save>(
    async () =>
      // oxlint-disable-next-line promise/avoid-new -- held open by the test
      await new Promise<void>((resolve) => {
        finishes.push(resolve);
      })
  );
  const finish = async () => {
    finishes.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { finish, save };
};

describe(createAutosave, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves once the value stops changing", async () => {
    const { autosave, save, statuses } = setup();
    autosave.change("ab");
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    autosave.change("abc");
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save.mock.calls).toStrictEqual([["abc"]]);
    expect(statuses).toStrictEqual(["pending", "pending", "saving", "saved"]);
  });

  it("does not save a value changed back", async () => {
    const { autosave, save, statuses } = setup();
    autosave.change("ab");
    autosave.change("a");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(save).not.toHaveBeenCalled();
    expect(statuses).toStrictEqual(["pending", "idle"]);
  });

  it("saves now when flushed", async () => {
    const { autosave, save } = setup();
    autosave.change("ab");
    await autosave.flush();
    expect(save.mock.calls).toStrictEqual([["ab"]]);

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(save).toHaveBeenCalledOnce();
  });

  it("has nothing to flush when unchanged", async () => {
    const { autosave, save, statuses } = setup();
    await autosave.flush();
    expect(save).not.toHaveBeenCalled();
    expect(statuses).toStrictEqual([]);
  });

  it("saves one at a time, and a change made during a save after it", async () => {
    const { finish, save: deferred } = deferredSave();
    const { autosave, save, statuses } = setup(deferred);
    autosave.change("ab");
    await vi.advanceTimersByTimeAsync(DELAY);
    autosave.change("abc");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(save.mock.calls).toStrictEqual([["ab"]]);

    await finish();
    expect(save.mock.calls).toStrictEqual([["ab"], ["abc"]]);
    await finish();
    expect(statuses).toStrictEqual(["pending", "saving", "saving", "saved"]);
  });

  it("waits out a change's delay after a save", async () => {
    const { finish, save: deferred } = deferredSave();
    const { autosave, save, statuses } = setup(deferred);
    autosave.change("ab");
    await vi.advanceTimersByTimeAsync(DELAY);
    autosave.change("abc");
    await finish();
    expect(statuses.at(-1)).toBe("pending");
    expect(save).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(save.mock.calls).toStrictEqual([["ab"], ["abc"]]);
  });

  it("flushes a change made during a save once it ends", async () => {
    const { finish, save: deferred } = deferredSave();
    const { autosave, save } = setup(deferred);
    autosave.change("ab");
    const first = autosave.flush();
    autosave.change("abc");
    const second = autosave.flush();
    await finish();
    await finish();
    await Promise.all([first, second]);
    expect(save.mock.calls).toStrictEqual([["ab"], ["abc"]]);
  });

  it("reports a failure, and tries again on the next change", async () => {
    const save = vi
      .fn<Save>(async () => {})
      .mockRejectedValueOnce(new Error("Disk full."));
    const { autosave, statuses } = setup(save);
    autosave.change("ab");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(statuses.at(-1)).toBe("error: Disk full.");

    await vi.advanceTimersByTimeAsync(DELAY * 10);
    expect(save).toHaveBeenCalledOnce();

    autosave.change("abc");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(save.mock.calls).toStrictEqual([["ab"], ["abc"]]);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("tries a value flushed during a failed save", async () => {
    const save = vi
      .fn<Save>(async () => {})
      .mockRejectedValueOnce(new Error("Disk full."));
    const { autosave, statuses } = setup(save);
    autosave.change("ab");
    const first = autosave.flush();
    autosave.change("abc");
    await Promise.all([first, autosave.flush()]);
    expect(save.mock.calls).toStrictEqual([["ab"], ["abc"]]);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("tells whether the latest value is still to be sent", async () => {
    const { finish, save: deferred } = deferredSave();
    const { autosave } = setup(deferred);
    autosave.change("ab");
    expect(autosave.unsent()).toBeTruthy();

    const flushed = autosave.flush();
    expect(autosave.unsent()).toBeFalsy();
    autosave.change("abc");
    expect(autosave.unsent()).toBeTruthy();

    await finish();
    await flushed;
    // Waiting out its delay.
    expect(autosave.unsent()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(autosave.unsent()).toBeFalsy();
  });
});
