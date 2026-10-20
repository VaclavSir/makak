import { describe, expect, it } from "vitest";

import { liveSandbox } from "./live-sandbox.ts";

const loaded = { id: "1", name: "s", status: "running" };

describe(liveSandbox, () => {
  it("takes the sandbox from the list, as it is now", () => {
    const now = { ...loaded, status: "stopped" };
    expect(liveSandbox(loaded, [now])).toStrictEqual({
      replaced: false,
      sandbox: now,
    });
  });

  it("knows when the name belongs to another sandbox", () => {
    expect(liveSandbox(loaded, [{ ...loaded, id: "2" }])).toStrictEqual({
      replaced: true,
      sandbox: undefined,
    });
  });

  it("knows when it is gone, and falls back without a list", () => {
    expect(liveSandbox(loaded, [])).toStrictEqual({
      replaced: false,
      sandbox: undefined,
    });
    expect(liveSandbox(loaded)).toStrictEqual({
      replaced: false,
      sandbox: loaded,
    });
  });
});
