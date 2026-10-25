import { describe, expect, it } from "vitest";

import { allowedHosts, checkRequest, isLoopback } from "./security.ts";
import type { RequestFacts } from "./security.ts";

const ORIGIN = "https://makakctl.test:7443";
const expected = { hosts: allowedHosts("makakctl.test", 7443), origin: ORIGIN };

const request = (overrides: Partial<RequestFacts> = {}): RequestFacts => ({
  host: "makakctl.test:7443",
  method: "GET",
  origin: undefined,
  remoteAddress: "127.0.0.1",
  upgrade: false,
  ...overrides,
});

describe(isLoopback, () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("accepts %s", (address) => {
    expect(isLoopback(address)).toBeTruthy();
  });

  it.each([
    "192.168.1.10",
    "10.0.0.1",
    "::ffff:10.0.0.1",
    "fe80::1",
    "",
    undefined,
  ])("rejects %s", (address) => {
    expect(isLoopback(address)).toBeFalsy();
  });
});

describe(allowedHosts, () => {
  it("requires the port unless it is 443", () => {
    expect(allowedHosts("makakctl.test", 7443)).toStrictEqual([
      "makakctl.test:7443",
    ]);
    expect(allowedHosts("makakctl.test", 443)).toStrictEqual([
      "makakctl.test",
      "makakctl.test:443",
    ]);
  });
});

describe(checkRequest, () => {
  it("accepts a plain GET from loopback to the Panel's host", () => {
    expect(checkRequest(request(), expected)).toStrictEqual({ ok: true });
  });

  it("rejects peers that are not loopback", () => {
    expect(
      checkRequest(request({ remoteAddress: "192.168.1.10" }), expected)
    ).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it.each([
    ["another hostname", "evil.test:7443"],
    ["another port", "makakctl.test:8000"],
    ["no port", "makakctl.test"],
    ["localhost", "localhost:7443"],
    ["no Host header", undefined],
  ])("rejects %s in the Host header (DNS rebinding)", (_, host) => {
    expect(checkRequest(request({ host }), expected)).toMatchObject({
      ok: false,
      status: 421,
    });
  });

  it("matches the Host header case-insensitively", () => {
    expect(
      checkRequest(request({ host: "MakakCtl.test:7443" }), expected).ok
    ).toBeTruthy();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "requires the Panel's Origin for %s (CSRF)",
    (method) => {
      expect(checkRequest(request({ method }), expected)).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(
        checkRequest(
          request({ method, origin: "https://feature-a.makak.test" }),
          expected
        )
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        checkRequest(request({ method, origin: ORIGIN }), expected).ok
      ).toBeTruthy();
    }
  );

  it("rejects an Origin on the same host but another port", () => {
    expect(
      checkRequest(
        request({ method: "POST", origin: "https://makakctl.test:8000" }),
        expected
      ).ok
    ).toBeFalsy();
  });

  it("requires the Panel's Origin for WebSocket upgrades, which are GETs", () => {
    expect(checkRequest(request({ upgrade: true }), expected).ok).toBeFalsy();
    expect(
      checkRequest(request({ origin: ORIGIN, upgrade: true }), expected).ok
    ).toBeTruthy();
  });

  it("lets a bearer request without an Origin through, but no browser's from another site", () => {
    const bearer = (origin?: string) =>
      checkRequest(request({ bearer: true, method: "POST", origin }), expected)
        .ok;
    expect(bearer()).toBeTruthy();
    expect(bearer(ORIGIN)).toBeTruthy();
    expect(bearer("https://evil.test")).toBeFalsy();
    expect(bearer("null")).toBeFalsy();
    expect(
      checkRequest(
        request({ bearer: true, host: "evil.test", method: "POST" }),
        expected
      ).ok
    ).toBeFalsy();
  });
});
