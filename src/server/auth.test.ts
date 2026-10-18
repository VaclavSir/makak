import { describe, expect, it } from "vitest";

import {
  createAuth,
  SESSION_COOKIE,
  sessionCookie,
  sessionIdsFromCookieHeader,
} from "./auth.ts";

describe(createAuth, () => {
  it("exchanges a login token for a valid session", () => {
    const auth = createAuth();
    const sessionId = auth.redeemLoginToken(auth.issueLoginToken());

    expect(sessionId).toBeTypeOf("string");
    expect(auth.isValidSession(sessionId ?? "")).toBeTruthy();
  });

  it("accepts each login token only once", () => {
    const auth = createAuth();
    const token = auth.issueLoginToken();

    expect(auth.redeemLoginToken(token)).toBeDefined();
    expect(auth.redeemLoginToken(token)).toBeUndefined();
  });

  it("rejects an expired login token", () => {
    let now = 0;
    const auth = createAuth({ now: () => now, ttlMs: 60_000 });
    const token = auth.issueLoginToken();

    now = 60_001;
    expect(auth.redeemLoginToken(token)).toBeUndefined();
  });

  it("rejects unknown tokens and sessions", () => {
    const auth = createAuth();
    auth.issueLoginToken();

    expect(auth.redeemLoginToken("guess")).toBeUndefined();
    expect(auth.isValidSession("guess")).toBeFalsy();
  });

  it("does not accept a login token as a session id", () => {
    const auth = createAuth();
    const token = auth.issueLoginToken();

    expect(auth.isValidSession(token)).toBeFalsy();
  });
});

describe("session cookie", () => {
  it("is host-only, HttpOnly, Secure and SameSite=Strict", () => {
    expect(sessionCookie("abc")).toBe(
      `${SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure; SameSite=Strict`
    );
    expect(SESSION_COOKIE).toMatch(/^__Host-/u);
  });

  it("finds every session value in a Cookie header", () => {
    expect(
      sessionIdsFromCookieHeader(
        `other=1; ${SESSION_COOKIE}=first;${SESSION_COOKIE}=second`
      )
    ).toStrictEqual(["first", "second"]);
    expect(sessionIdsFromCookieHeader()).toStrictEqual([]);
    expect(sessionIdsFromCookieHeader("makak-session=x")).toStrictEqual([]);
  });
});
