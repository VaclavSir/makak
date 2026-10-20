import { describe, expect, it } from "vitest";

import {
  neighbourTab,
  parseStoredTabs,
  replaceTab,
  runIdOf,
  syncTabs,
} from "./run-tabs.ts";

const A = "20261020-100000-aaaaaa";
const B = "20261020-110000-bbbbbb";
const C = "20261020-120000-cccccc";
const D = "20261020-130000-dddddd";

describe(syncTabs, () => {
  it("adds running runs, oldest first, after the open ones", () => {
    expect(
      syncTabs(
        [B],
        [
          { id: C, state: "running" },
          { id: B, state: "exited" },
          { id: A, state: "running" },
        ]
      )
    ).toStrictEqual([B, A, C]);
  });

  it("keeps a closed finished run closed", () => {
    expect(syncTabs([], [{ id: A, state: "exited" }])).toStrictEqual([]);
  });

  it("adds the run being viewed", () => {
    expect(
      syncTabs(
        [A],
        [
          { id: A, state: "exited" },
          { id: B, state: "exited" },
        ],
        B
      )
    ).toStrictEqual([A, B]);
  });

  it("drops runs that no longer exist, but not ones too new to be listed", () => {
    expect(
      syncTabs(
        [A, D, B],
        [
          { id: B, state: "exited" },
          { id: C, state: "exited" },
        ]
      )
    ).toStrictEqual([D, B]);
  });

  it("keeps every open tab when the runs are unknown", () => {
    expect(syncTabs([A, B], undefined, C)).toStrictEqual([A, B, C]);
    expect(syncTabs([A], [])).toStrictEqual([A]);
  });
});

describe(replaceTab, () => {
  it("moves a tab to its rerun, in place", () => {
    expect(replaceTab([A, B, C], B, D)).toStrictEqual([A, D, C]);
  });

  it("opens the rerun when the tab was closed", () => {
    expect(replaceTab([A], B, D)).toStrictEqual([A, D]);
  });

  it("never shows a run twice", () => {
    expect(replaceTab([A, B, D], B, D)).toStrictEqual([A, D]);
    expect(replaceTab([D], B, D)).toStrictEqual([D]);
  });
});

describe(neighbourTab, () => {
  it("picks the next tab, else the previous, else none", () => {
    expect(neighbourTab([A, B, C], B)).toBe(C);
    expect(neighbourTab([A, B, C], C)).toBe(B);
    expect(neighbourTab([A], A)).toBeUndefined();
    expect(neighbourTab([A], B)).toBeUndefined();
  });
});

describe(parseStoredTabs, () => {
  it.each([
    [null, []],
    ["", []],
    ["{", []],
    ['{"a":1}', []],
    [JSON.stringify([A, 3, "../x", B]), [A, B]],
  ])("reads %j as %j", (stored, tabs) => {
    expect(parseStoredTabs(stored)).toStrictEqual(tabs);
  });
});

describe(runIdOf, () => {
  it.each([
    [`/sandboxes/s/runs/${A}`, A],
    [`https://panel.test/sandboxes/s/runs/${A}?x=1`, A],
    ["/sandboxes/s", undefined],
    ["/sandboxes/s/runs/a%2Fb", undefined],
    ["/sandboxes/s/runs/%E0", undefined],
  ])("reads %s as %s", (location, id) => {
    expect(runIdOf(location)).toBe(id);
  });
});
