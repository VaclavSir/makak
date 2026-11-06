import { setImmediate as tick } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createShared } from "./shared.ts";

const clock = () => {
  let time = 0;
  return {
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
};

/** Each load waits until the test resolves or fails it, by its index. */
const loader = () => {
  let calls = 0;
  const waiting: PromiseWithResolvers<string>[] = [];
  const load = () => {
    calls += 1;
    const answer = Promise.withResolvers<string>();
    waiting.push(answer);
    return answer.promise;
  };
  return {
    calls: () => calls,
    fail: (index: number) => {
      waiting[index]?.reject(new Error(`load ${index} failed`));
    },
    load,
    resolve: (index: number, value: string) => {
      waiting[index]?.resolve(value);
    },
  };
};

describe(createShared, () => {
  it("shares a load in progress, however long it takes", async () => {
    const time = clock();
    const loads = loader();
    const shared = createShared(loads.load, { now: time.now, ttlMs: 100 });

    const first = shared.get();
    time.advance(1000);
    const second = shared.get();
    expect(loads.calls()).toBe(1);
    loads.resolve(0, "a");
    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      "a",
      "a",
    ]);
    expect(shared.last()).toStrictEqual({ at: 1000, value: "a" });
  });

  it("reuses a finished value for ttlMs", async () => {
    const time = clock();
    const loads = loader();
    const shared = createShared(loads.load, { now: time.now, ttlMs: 100 });
    const first = shared.get();
    loads.resolve(0, "a");
    await first;

    time.advance(99);
    await expect(shared.get()).resolves.toBe("a");
    time.advance(1);
    const third = shared.get();
    expect(loads.calls()).toBe(2);
    loads.resolve(1, "b");
    await expect(third).resolves.toBe("b");
  });

  it("doesn't keep a failure", async () => {
    const loads = loader();
    const shared = createShared(loads.load, { ttlMs: 100 });
    const failing = shared.get();
    loads.fail(0);
    await expect(failing).rejects.toThrow("load 0 failed");
    await tick();
    const retried = shared.get();
    expect(loads.calls()).toBe(2);
    loads.resolve(1, "a");
    await expect(retried).resolves.toBe("a");
  });

  it("expires a finished value, but keeps a load in progress", async () => {
    const loads = loader();
    const shared = createShared(loads.load, { ttlMs: 100 });
    const first = shared.get();
    shared.expire();
    expect(shared.get()).toBe(first);
    loads.resolve(0, "a");
    await first;
    await tick();
    expect(shared.last()?.value).toBe("a");

    shared.expire();
    expect(shared.last()).toBeUndefined();
    void shared.get();
    expect(loads.calls()).toBe(2);
  });

  it("forgets a load in progress, and doesn't keep its value", async () => {
    const loads = loader();
    const shared = createShared(loads.load, { ttlMs: 100 });
    const before = shared.get();
    shared.forget();
    const after = shared.get();
    expect(loads.calls()).toBe(2);

    loads.resolve(0, "old");
    await expect(before).resolves.toBe("old");
    await tick();
    expect(shared.last()).toBeUndefined();
    loads.resolve(1, "new");
    await expect(after).resolves.toBe("new");
    await tick();
    expect(shared.last()?.value).toBe("new");
  });

  it("takes a value set from elsewhere as fresh", async () => {
    const time = clock();
    const loads = loader();
    const shared = createShared(loads.load, { now: time.now, ttlMs: 100 });
    time.advance(5);
    shared.set("given");
    await expect(shared.get()).resolves.toBe("given");
    expect(shared.last()).toStrictEqual({ at: 5, value: "given" });
    expect(loads.calls()).toBe(0);
  });
});
