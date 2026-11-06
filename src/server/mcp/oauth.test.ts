import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOAuth } from "./oauth.ts";
import type { OAuth } from "./oauth.ts";

const REDIRECT = "https://makakctl.test:7443/oauth/callback";

interface Fake {
  /** Codes the browser would bring back, with the PKCE challenge they're for. */
  codes: Map<string, string>;
  registered: Record<string, unknown>[];
  /** What the next token request answers to a refresh. */
  refreshes: "accept" | "refuse" | "unavailable";
  /** The resource its metadata claims to be. */
  resource?: string;
  /** The authorization server its metadata names. */
  issuer?: string;
  tokenRequests: URLSearchParams[];
  /** Metadata pointing somewhere it must not. */
  insecure: boolean;
  /** Registration and tokens answered with a page, as a captive portal does. */
  pages?: boolean;
}

/** Answers registration and tokens with a page, when the fake says so. */
const answersWithPage = (
  fake: Fake,
  req: IncomingMessage,
  res: ServerResponse
) => {
  if (
    fake.pages !== true ||
    req.method !== "POST" ||
    !["/oauth/register", "/oauth/token"].includes(req.url ?? "")
  ) {
    return false;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html>Log in to the Wi-Fi</html>");
  return true;
};

/**
 * A server shaped like GitLab's: the MCP endpoint's 401 points to its
 * metadata, and the authorization server's RFC 8414 URL answers with HTML,
 * so only the OpenID one works.
 */
const fakeGitLab = (fake: Fake) =>
  createServer(async (req, res) => {
    const base = `http://${req.headers.host}`;
    let text = "";
    for await (const chunk of req) {
      text += String(chunk);
    }
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (answersWithPage(fake, req, res)) {
      return;
    }
    switch (`${req.method} ${req.url}`) {
      case "POST /api/v4/mcp": {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/v4/mcp"`,
        });
        res.end();
        return;
      }
      case "GET /.well-known/oauth-protected-resource/api/v4/mcp": {
        json({
          authorization_servers: [fake.issuer ?? base],
          resource: fake.resource ?? `${base}/api/v4/mcp`,
        });
        return;
      }
      case "GET /.well-known/oauth-authorization-server": {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Sign in</html>");
        return;
      }
      case "GET /.well-known/openid-configuration": {
        json({
          authorization_endpoint: `${base}/oauth/authorize`,
          code_challenge_methods_supported: ["S256"],
          registration_endpoint: `${base}/oauth/register`,
          token_endpoint: fake.insecure
            ? "http://gitlab.example.com/oauth/token"
            : `${base}/oauth/token`,
        });
        return;
      }
      case "POST /oauth/register": {
        fake.registered.push(JSON.parse(text) as Record<string, unknown>);
        json({ client_id: `client-${fake.registered.length}` }, 201);
        return;
      }
      case "POST /oauth/token": {
        const params = new URLSearchParams(text);
        fake.tokenRequests.push(params);
        if (params.get("grant_type") === "authorization_code") {
          const challenge = fake.codes.get(params.get("code") ?? "");
          const verifier = params.get("code_verifier") ?? "";
          const hashed = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (challenge === undefined || challenge !== hashed) {
            json({ error: "invalid_grant" }, 400);
            return;
          }
          json({
            access_token: "at-1",
            expires_in: 3600,
            refresh_token: "rt-1",
          });
          return;
        }
        if (fake.refreshes === "refuse") {
          json({ error: "invalid_grant" }, 400);
          return;
        }
        if (fake.refreshes === "unavailable") {
          json({ error: "temporarily_unavailable" }, 503);
          return;
        }
        json({ access_token: "at-2", expires_in: 3600 });
        return;
      }
      default: {
        res.writeHead(404);
        res.end();
      }
    }
  });

describe(createOAuth, () => {
  let base: string;
  let dir: string;
  let fake: Fake;
  let now: number;
  let server: Server;

  /** Whether requests to the token endpoint fail before reaching it. */
  let offline = false;

  const oauthFor = (redirectUri = REDIRECT): OAuth =>
    createOAuth({
      fetch: (input, init) =>
        offline && String(input).endsWith("/oauth/token")
          ? Promise.reject(new TypeError("fetch failed"))
          : fetch(input, init),
      now: () => now,
      redirectUri,
      servers: [{ name: "gitlab", scopes: ["mcp"], url: `${base}/api/v4/mcp` }],
      stateDir: dir,
    });

  /** What the browser does: signs in, and comes back with a code. */
  const signIn = async (oauth: OAuth) => {
    const url = new URL(await oauth.begin("gitlab"));
    const code = `code-${fake.codes.size + 1}`;
    fake.codes.set(code, url.searchParams.get("code_challenge") ?? "");
    const state = url.searchParams.get("state") ?? "";
    await oauth.finish(state, code);
    return { state, url };
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-oauth-"));
    fake = {
      codes: new Map(),
      insecure: false,
      refreshes: "accept",
      registered: [],
      tokenRequests: [],
    };
    now = Date.parse("2026-10-25T10:00:00Z");
    offline = false;
    server = fakeGitLab(fake);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.close();
    await rm(dir, { force: true, recursive: true });
  });

  it("sends the browser to sign in with PKCE, after registering the Panel", async () => {
    const url = new URL(await oauthFor().begin("gitlab"));
    expect(`${url.origin}${url.pathname}`).toBe(`${base}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      code_challenge_method: "S256",
      redirect_uri: REDIRECT,
      resource: `${base}/api/v4/mcp`,
      response_type: "code",
      scope: "mcp",
    });
    expect(fake.registered).toMatchObject([
      {
        redirect_uris: [REDIRECT],
        scope: "mcp",
        token_endpoint_auth_method: "none",
      },
    ]);
  });

  it("signs in with the code the browser brings back", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    await expect(oauth.status("gitlab")).resolves.toStrictEqual({
      expiresAt: "2026-10-25T11:00:00.000Z",
      signedIn: true,
    });
    await expect(oauth.accessToken("gitlab")).resolves.toBe("at-1");
    expect(fake.tokenRequests[0]?.get("resource")).toBe(`${base}/api/v4/mcp`);
  });

  it("ends each sign-in once, and only one it started", async () => {
    const oauth = oauthFor();
    const { state } = await signIn(oauth);
    await expect(oauth.finish(state, "code-1")).rejects.toThrow(/expired/u);
    await expect(oauth.finish("forged", "code-1")).rejects.toThrow(/expired/u);
  });

  it("names the server of a sign-in in progress without ending it", async () => {
    const oauth = oauthFor();
    const url = new URL(await oauth.begin("gitlab"));
    const state = url.searchParams.get("state") ?? "";
    expect(oauth.pendingServer(state)).toBe("gitlab");
    expect(oauth.pendingServer(state)).toBe("gitlab");
    expect(oauth.pendingServer("forged")).toBeUndefined();
  });

  it("refuses a code without the verifier it was issued for", async () => {
    const oauth = oauthFor();
    const url = new URL(await oauth.begin("gitlab"));
    fake.codes.set("stolen", "another challenge");
    await expect(
      oauth.finish(url.searchParams.get("state") ?? "", "stolen")
    ).rejects.toThrow(/refused the sign-in/u);
    await expect(oauth.status("gitlab")).resolves.toStrictEqual({
      signedIn: false,
    });
  });

  it("says when registering or signing in gets a page instead of JSON", async () => {
    fake.pages = true;
    await expect(oauthFor().begin("gitlab")).rejects.toThrow(
      /refused to register the Panel/u
    );
    fake.pages = false;
    const oauth = oauthFor();
    const url = new URL(await oauth.begin("gitlab"));
    fake.pages = true;
    await expect(
      oauth.finish(url.searchParams.get("state") ?? "", "code-1")
    ).rejects.toThrow(/refused the sign-in/u);
  });

  it("keeps its registration, unless the Panel's address changed", async () => {
    await signIn(oauthFor());
    await signIn(oauthFor());
    expect(fake.registered).toHaveLength(1);
    await signIn(oauthFor("https://panel.test:9443/oauth/callback"));
    expect(fake.registered).toHaveLength(2);
  });

  it("refreshes a token about to expire, keeping the refresh token", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    now += 3_600_000 - 30_000;
    await expect(oauth.accessToken("gitlab")).resolves.toBe("at-2");
    expect(fake.tokenRequests[1]?.get("refresh_token")).toBe("rt-1");
    now += 3_600_000;
    await expect(oauth.accessToken("gitlab")).resolves.toBe("at-2");
    expect(fake.tokenRequests[2]?.get("refresh_token")).toBe("rt-1");
  });

  it("signs out when the server refuses the refresh", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    fake.refreshes = "refuse";
    await expect(oauth.refresh("gitlab")).resolves.toBeUndefined();
    await expect(oauth.accessToken("gitlab")).resolves.toBeUndefined();
  });

  it("stays signed in when a refresh fails for now", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    fake.refreshes = "unavailable";
    await expect(oauth.refresh("gitlab")).rejects.toThrow(/HTTP 503/u);
    offline = true;
    await expect(oauth.refresh("gitlab")).rejects.toThrow(/couldn't reach/u);
    await expect(oauth.status("gitlab")).resolves.toMatchObject({
      signedIn: true,
    });
  });

  it("refreshes once for requests refused with the same token", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    await expect(oauth.refresh("gitlab", "at-1")).resolves.toBe("at-2");
    await expect(oauth.refresh("gitlab", "at-1")).resolves.toBe("at-2");
    expect(fake.tokenRequests).toHaveLength(2);
  });

  it("keeps a sign-in whose code couldn't be sent, so it can be sent again", async () => {
    const oauth = oauthFor();
    const url = new URL(await oauth.begin("gitlab"));
    fake.codes.set("code-1", url.searchParams.get("code_challenge") ?? "");
    const state = url.searchParams.get("state") ?? "";
    offline = true;
    await expect(oauth.finish(state, "code-1")).rejects.toThrow(
      /couldn't reach/u
    );
    offline = false;
    await expect(oauth.finish(state, "code-1")).resolves.toBe("gitlab");
  });

  it("counts an expired token it can't refresh as signed out", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    await writeFile(
      path.join(dir, "oauth.json"),
      JSON.stringify({
        servers: {
          gitlab: {
            tokens: { accessToken: "at-1", expiresAt: "2026-10-25T09:00:00Z" },
          },
        },
      })
    );
    await expect(oauth.status("gitlab")).resolves.toStrictEqual({
      signedIn: false,
    });
  });

  it("uses a token whose expiry can't be read until the server refuses it", async () => {
    const oauth = oauthFor();
    await signIn(oauth);
    await writeFile(
      path.join(dir, "oauth.json"),
      JSON.stringify({
        servers: {
          gitlab: { tokens: { accessToken: "at-1", expiresAt: "?" } },
        },
      })
    );
    await expect(oauth.accessToken("gitlab")).resolves.toBe("at-1");
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it("refuses metadata for another resource", async () => {
    fake.resource = `${base}/other/mcp`;
    await expect(oauthFor().begin("gitlab")).rejects.toThrow(
      /metadata is for .*\/other\/mcp/u
    );
  });

  it("won't read metadata from an authorization server that isn't HTTPS", async () => {
    fake.issuer = "http://gitlab.example.com";
    await expect(oauthFor().begin("gitlab")).rejects.toThrow(
      /authorization server is not an HTTPS URL/u
    );
  });

  it("won't send credentials to an endpoint that isn't HTTPS", async () => {
    fake.insecure = true;
    await expect(oauthFor().begin("gitlab")).rejects.toThrow(
      /token endpoint is not an HTTPS URL/u
    );
  });

  it("says when a server has nowhere to sign in", async () => {
    const plain = createServer((_, res) => {
      res.writeHead(404);
      res.end();
    });
    plain.listen(0, "127.0.0.1");
    await once(plain, "listening");
    const { port } = plain.address() as AddressInfo;
    const oauth = createOAuth({
      redirectUri: REDIRECT,
      servers: [
        { name: "plain", scopes: [], url: `http://127.0.0.1:${port}/mcp` },
      ],
      stateDir: dir,
    });
    await expect(oauth.begin("plain")).rejects.toThrow(/no OAuth metadata/u);
    await expect(oauth.begin("jira")).rejects.toThrow(/doesn't sign in/u);
    plain.close();
  });
});
