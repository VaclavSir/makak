import { setImmediate as tick } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { mapLimited, quietly, settled } from "./promises.ts";

describe(settled, () => {
  it("waits, and ignores a failure", async () => {
    await expect(
      settled(Promise.reject(new Error("no")))
    ).resolves.toBeUndefined();
  });
});

describe(quietly, () => {
  it("runs the follow-up, and ignores its failure", async () => {
    let ran = false;
    await expect(
      quietly(async () => {
        ran = true;
        await tick();
        throw new Error("no");
      })
    ).resolves.toBeUndefined();
    expect(ran).toBeTruthy();
  });
});

describe(mapLimited, () => {
  it("keeps the order, running at most the limit at once", async () => {
    let running = 0;
    let most = 0;
    const results = await mapLimited([3, 1, 2, 5, 4], 2, async (value) => {
      running += 1;
      most = Math.max(most, running);
      for (let wait = 0; wait < value; wait += 1) {
        // oxlint-disable-next-line no-await-in-loop -- longer for larger values
        await tick();
      }
      running -= 1;
      return value * 10;
    });
    expect(results).toStrictEqual([30, 10, 20, 50, 40]);
    expect(most).toBe(2);
  });

  it("maps nothing to nothing, and fails like Promise.all", async () => {
    await expect(
      mapLimited([], 4, async () => await tick())
    ).resolves.toStrictEqual([]);
    await expect(
      mapLimited([1, 2], 4, async (value) => {
        await tick();
        if (value === 2) {
          throw new Error("two");
        }
        return value;
      })
    ).rejects.toThrow("two");
  });
});
