import { describe, expect, it } from "vitest";

import {
  hostLabel,
  isElevated,
  resolveUpstream,
  sandboxUrls,
} from "./proxy-urls.ts";

const tcp = (sandboxPort: number, protocol = "tcp4") => ({
  protocol,
  sandboxPort,
});

describe(hostLabel, () => {
  it.each([
    ["claude-SBX", "claude-sbx"],
    ["test2", "test2"],
    ["under_score", undefined],
    ["-dash", undefined],
    ["a.b", undefined],
  ])("makes %s the label %s", (name, label) => {
    expect(hostLabel(name)).toBe(label);
  });
});

describe(resolveUpstream, () => {
  it("takes the first candidate that is published", () => {
    expect(resolveUpstream([tcp(8000), tcp(443)], [443, 8000])).toStrictEqual({
      ok: true,
      port: tcp(443),
    });
  });

  it("falls back to later candidates", () => {
    expect(resolveUpstream([tcp(8000)], [443, 8000])).toMatchObject({
      ok: true,
      port: { sandboxPort: 8000 },
    });
  });

  it("ignores UDP ports", () => {
    expect(resolveUpstream([tcp(8000, "udp4")], [8000]).ok).toBeFalsy();
  });

  it("asks for the last candidate when none is published", () => {
    expect(resolveUpstream([], [443, 8000])).toStrictEqual({
      ok: false,
      publish: 8000,
    });
  });
});

describe(isElevated, () => {
  const rules = [{ port: 8000, sandbox: "^client-" }, { sandbox: "^legacy$" }];

  it.each([
    ["client-a", 8000, true],
    ["client-a", 35_729, false],
    ["my-client-a", 8000, false],
    ["legacy", 35_729, true],
    ["legacy-2", 8000, false],
  ])("elevates %s port %i: %s", (name, port, elevated) => {
    expect(isElevated(rules, name, port)).toBe(elevated);
  });
});

describe(sandboxUrls, () => {
  const settings = {
    elevate: [{ port: 8000, sandbox: "^a$" }],
    listeners: [
      { port: 443, upstream: [443, 8000], websocket: false },
      { port: 35_729, upstream: [35_729], websocket: true },
    ],
    suffixes: [".makak.test", ".client.test"],
  };

  it("lists one URL per suffix and listener, with the port unless 443", () => {
    expect(
      sandboxUrls("Feature-A", [], settings)?.map(({ url }) => url)
    ).toStrictEqual([
      "https://feature-a.makak.test/",
      "wss://feature-a.makak.test:35729/",
      "https://feature-a.client.test/",
      "wss://feature-a.client.test:35729/",
    ]);
  });

  it("resolves each URL's port", () => {
    const [web, live] = sandboxUrls("a", [tcp(8000)], settings) ?? [];
    expect(web).toMatchObject({ elevated: true, resolution: { ok: true } });
    expect(live?.resolution).toStrictEqual({ ok: false, publish: 35_729 });
  });

  it("has none for a name that can't be a hostname", () => {
    expect(sandboxUrls("a_b", [], settings)).toBeUndefined();
  });
});
