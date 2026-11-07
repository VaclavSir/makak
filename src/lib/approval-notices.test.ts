import { describe, expect, it } from "vitest";

import {
  bellOf,
  createNewNotices,
  noticeText,
  parseNotices,
} from "./approval-notices.ts";

const A = { id: "a", server: "gitlab", tool: "create_note" };
const B = { id: "b", server: "jira", tool: "add_comment" };
const C = { id: "c", server: "gitlab", tool: "merge" };

describe(createNewNotices, () => {
  it("takes the first list as already seen", () => {
    const newNotices = createNewNotices();
    expect(newNotices([A])).toStrictEqual([]);
    expect(newNotices([A, B])).toStrictEqual([B]);
  });

  it("finds what came while disconnected, but not what left", () => {
    const newNotices = createNewNotices();
    newNotices([A, B]);
    expect(newNotices([B, C])).toStrictEqual([C]);
    expect(newNotices([])).toStrictEqual([]);
  });
});

describe(bellOf, () => {
  it("is blocked whenever the browser denies it", () => {
    expect(
      bellOf({ enabled: true, permission: "denied", stopped: false })
    ).toBe("blocked");
  });

  it("is off until both chosen and allowed", () => {
    expect(
      bellOf({ enabled: true, permission: "default", stopped: false })
    ).toBe("off");
    expect(
      bellOf({ enabled: false, permission: "granted", stopped: true })
    ).toBe("off");
  });

  it("says when the stream stopped", () => {
    expect(
      bellOf({ enabled: true, permission: "granted", stopped: false })
    ).toBe("on");
    expect(
      bellOf({ enabled: true, permission: "granted", stopped: true })
    ).toBe("stopped");
  });
});

describe(parseNotices, () => {
  it("reads a list, and refuses anything else", () => {
    expect(parseNotices(JSON.stringify([A]))).toStrictEqual([A]);
    expect(parseNotices("not json")).toBeUndefined();
    expect(parseNotices(JSON.stringify([{ id: 1 }]))).toBeUndefined();
    expect(parseNotices(JSON.stringify({ id: "a" }))).toBeUndefined();
  });
});

describe(noticeText, () => {
  it("names the tool and server only", () => {
    expect(noticeText(A)).toStrictEqual({
      body: "create_note on gitlab",
      title: "Tool call waiting",
    });
  });
});
