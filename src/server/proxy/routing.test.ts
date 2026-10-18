import { describe, expect, it } from "vitest";

import { hostnameOf, matchHost } from "./routing.ts";

describe(hostnameOf, () => {
  it.each([
    ["web.makak.test:8443", "web.makak.test"],
    ["Web.Makak.Test.", "web.makak.test"],
    ["[::1]:443", "[::1]"],
  ])("reads %s as %s", (host, hostname) => {
    expect(hostnameOf(host)).toBe(hostname);
  });
});

describe(matchHost, () => {
  const suffixes = [".test", ".makak.test", ".client.test.acme.com"];

  it("takes the longest matching suffix", () => {
    expect(matchHost("web.makak.test", suffixes)).toStrictEqual({
      label: "web",
      suffix: ".makak.test",
      type: "sandbox",
    });
  });

  it("uses a shorter suffix when the longer one doesn't match", () => {
    expect(matchHost("web.test:443", suffixes)).toMatchObject({
      label: "web",
      suffix: ".test",
    });
  });

  it("matches suffixes under real domains", () => {
    expect(matchHost("web.client.test.acme.com", suffixes)).toMatchObject({
      label: "web",
    });
  });

  it("recognizes the bare suffix", () => {
    expect(matchHost("makak.test", suffixes)).toStrictEqual({
      suffix: ".makak.test",
      type: "bare",
    });
  });

  it.each([
    ["a foreign host", "example.com"],
    ["a name that only ends like a suffix", "webmakak.test.org"],
    ["a missing Host header", undefined],
    ["more than one label", "a.b.client.test.acme.com"],
  ])("matches nothing for %s", (_, host) => {
    expect(
      matchHost(host, [".makak.test", ".client.test.acme.com"])
    ).toStrictEqual({
      type: "none",
    });
  });
});
