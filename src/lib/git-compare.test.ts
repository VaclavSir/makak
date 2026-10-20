import { describe, expect, it } from "vitest";

import { explain, summarize } from "./git-compare.ts";

const SHA = "abc1234def5678abc1234def5678abc1234def56";

describe(summarize, () => {
  it.each([
    [undefined, "none"],
    [{ ahead: 0, behind: 0, sha: SHA }, "same"],
    [{ ahead: 2, behind: 0, sha: SHA }, "2 ahead"],
    [{ ahead: 0, behind: 1, sha: SHA }, "1 behind"],
    [{ ahead: 2, behind: 1, sha: SHA }, "2 ahead, 1 behind"],
  ])("summarizes %j as %s", (comparison, text) => {
    expect(summarize(comparison)).toBe(text);
  });
});

describe(explain, () => {
  it.each([
    [undefined, "The host has no main branch."],
    [
      { ahead: 0, behind: 0, sha: SHA },
      "The sandbox's main is the same as the host's main (abc1234).",
    ],
    [
      { ahead: 1, behind: 0, sha: SHA },
      "The sandbox has 1 commit that the host's main (abc1234) doesn't.",
    ],
    [
      { ahead: 2, behind: 3, sha: SHA },
      "The sandbox has 2 commits that the host's main (abc1234) doesn't. The host's main (abc1234) has 3 commits that the sandbox doesn't.",
    ],
  ])("explains %j against the host", (comparison, text) => {
    expect(explain("main", "the host", comparison)).toBe(text);
  });

  it("names origin", () => {
    expect(explain("main", "origin")).toBe("Origin has no main branch.");
    expect(explain("main", "origin", { ahead: 0, behind: 1, sha: SHA })).toBe(
      "Origin's main (abc1234) has 1 commit that the sandbox doesn't."
    );
  });
});
