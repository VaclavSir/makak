import { describe, expect, it } from "vitest";

import { runLabel, runTone } from "./runs.ts";

describe("run outcomes", () => {
  it.each([
    [{ exitCode: undefined, state: "running" }, "running", "running"],
    [{ exitCode: 0, state: "exited" }, "done", "ok"],
    [{ exitCode: 2, state: "exited" }, "failed (2)", "bad"],
    [{ exitCode: undefined, state: "stopped" }, "stopped", "ok"],
    [{ exitCode: undefined, state: "lost" }, "ended unrecorded", "bad"],
  ] as const)("shows %j as %s, %s", (run, label, tone) => {
    expect(runLabel(run)).toBe(label);
    expect(runTone(run)).toBe(tone);
  });
});
