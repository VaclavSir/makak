import { describe, expect, it } from "vitest";

import { parseOrder, sortSandboxes } from "./sandbox-order.ts";

const sandbox = (name: string, createdAt?: string, lastUsedAt?: string) => ({
  createdAt,
  lastUsedAt,
  name,
});

const sandboxes = [
  sandbox("b", "2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z"),
  sandbox("a", "2026-10-10T00:00:00Z", "2026-10-15T00:00:00Z"),
  sandbox("d"),
  sandbox("c", "2026-10-05T00:00:00Z", "2026-10-20T00:00:00Z"),
  sandbox("e", "nonsense", "nonsense"),
];

const names = (order: Parameters<typeof sortSandboxes>[1]) =>
  sortSandboxes(sandboxes, order).map(({ name }) => name);

describe(sortSandboxes, () => {
  it("puts the most recently used first, then by name, unknown times last", () => {
    expect(names("recent")).toStrictEqual(["b", "c", "a", "d", "e"]);
  });

  it("puts the newest first", () => {
    expect(names("created")).toStrictEqual(["a", "c", "b", "d", "e"]);
  });

  it("sorts by name", () => {
    expect(names("name")).toStrictEqual(["a", "b", "c", "d", "e"]);
  });

  it("leaves the list it was given alone", () => {
    sortSandboxes(sandboxes, "name");
    expect(sandboxes[0]?.name).toBe("b");
  });
});

describe(parseOrder, () => {
  it.each([
    ["name", "name"],
    ["created", "created"],
    ["recent", "recent"],
    [null, "created"],
    ["toString", "created"],
  ])("reads %j as %s", (stored, order) => {
    expect(parseOrder(stored)).toBe(order);
  });
});
