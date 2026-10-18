import { describe, expect, it } from "vitest";

import { createSandboxes } from "./sandboxes.ts";
import { FAKE_SANDBOXES } from "./tools/sbx.ts";
import type { Sandbox } from "./tools/sbx.ts";

const counting = (results: (Sandbox[] | Error)[]) => {
  let calls = 0;
  const list = () => {
    const result = results[Math.min(calls, results.length - 1)];
    calls += 1;
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result ?? []);
  };
  return { calls: () => calls, list };
};

const clock = () => {
  let time = 0;
  return {
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
};

const names = (sandboxes: Sandbox[]) => sandboxes.map(({ name }) => name);

describe(createSandboxes, () => {
  it("sorts by name", async () => {
    const sbx = counting([[...FAKE_SANDBOXES].toReversed()]);
    await expect(
      createSandboxes(sbx).list().then(names)
    ).resolves.toStrictEqual(["claude-makak", "feature-a", "old-experiment"]);
  });

  it("shares one sbx call between concurrent and recent callers", async () => {
    const time = clock();
    const sbx = counting([[...FAKE_SANDBOXES]]);
    const sandboxes = createSandboxes(sbx, { now: time.now, ttlMs: 2000 });

    await Promise.all([sandboxes.list(), sandboxes.find("feature-a")]);
    time.advance(1999);
    await sandboxes.list();
    expect(sbx.calls()).toBe(1);

    time.advance(1);
    await sandboxes.list();
    expect(sbx.calls()).toBe(2);
  });

  it("shares a slow listing however long it takes", async () => {
    const time = clock();
    const pending = Promise.withResolvers<Sandbox[]>();
    let calls = 0;
    const sandboxes = createSandboxes(
      {
        list: () => {
          calls += 1;
          return pending.promise;
        },
      },
      { now: time.now, ttlMs: 2000 }
    );

    const first = sandboxes.list();
    time.advance(10_000);
    const second = sandboxes.list();
    pending.resolve([...FAKE_SANDBOXES]);
    await Promise.all([first, second]);
    time.advance(1999);
    await sandboxes.list();
    expect(calls).toBe(1);
  });

  it("retries after a failure instead of caching it", async () => {
    const sbx = counting([new Error("sbx is down"), [...FAKE_SANDBOXES]]);
    const sandboxes = createSandboxes(sbx);

    await expect(sandboxes.list()).rejects.toThrow("sbx is down");
    await expect(sandboxes.find("feature-a")).resolves.toMatchObject({
      name: "feature-a",
    });
  });

  it("finds nothing for an unknown name", async () => {
    const sandboxes = createSandboxes(counting([[...FAKE_SANDBOXES]]));
    await expect(sandboxes.find("nope")).resolves.toBeUndefined();
  });
});
