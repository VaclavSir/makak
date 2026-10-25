import { describe, expect, it } from "vitest";

import { argumentFields, argumentsSummary, formatHold } from "./mcp.ts";

describe(argumentFields, () => {
  it("shows text as written, and everything else as JSON", () => {
    expect(
      argumentFields({ body: "Looks good.\n\nShip it.", iid: 7, labels: ["a"] })
    ).toStrictEqual([
      { json: false, name: "body", text: "Looks good.\n\nShip it." },
      { json: true, name: "iid", text: "7" },
      { json: true, name: "labels", text: '[\n  "a"\n]' },
    ]);
  });

  it("shows arguments that aren't an object whole", () => {
    expect(argumentFields()).toStrictEqual([]);
    expect(argumentFields(["a"])).toStrictEqual([
      { json: true, name: "", text: '[\n  "a"\n]' },
    ]);
    expect(argumentFields("x")).toStrictEqual([
      { json: true, name: "", text: '"x"' },
    ]);
  });
});

describe(argumentsSummary, () => {
  it("fits the arguments on a line", () => {
    expect(argumentsSummary({ iid: 7 })).toBe('{"iid":7}');
    expect(argumentsSummary({ body: "x".repeat(50) }, 20)).toBe(
      '{"body":"xxxxxxxxxx…'
    );
    expect(argumentsSummary()).toBe("");
  });
});

describe(formatHold, () => {
  it.each([
    [240, "4 min"],
    [14_400, "4 h"],
    [90, "90 s"],
  ])("shows %i seconds as %s", (seconds, text) => {
    expect(formatHold(seconds)).toBe(text);
  });
});
