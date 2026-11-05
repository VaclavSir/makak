import { once } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request } from "node:https";
import type { Server } from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { text } from "node:stream/consumers";
import { connect as tlsConnect } from "node:tls";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth, LOGIN_PATH, SESSION_COOKIE } from "./auth.ts";
import type { Auth } from "./auth.ts";
import { createPanelServer, panelOrigin } from "./panel.ts";
import type { PanelApp } from "./panel.ts";
import { selfSignedCert } from "./test-support/tls.ts";

const HOSTNAME = "makakctl.test";

interface Response {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

interface Send {
  address?: string;
  cookie?: string;
  headers?: Record<string, string>;
  host?: string;
  method?: string;
  origin?: string;
  path?: string;
}

const freePort = async (): Promise<number> => {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return port;
};

/** An app that records what reached it. */
const recordingApp = () => {
  const reached: string[] = [];
  const app: PanelApp = {
    handle: (req, res) => {
      reached.push(`${req.method} ${req.url}`);
      res.end("app");
    },
    upgrade: (req, socket) => {
      reached.push(`UPGRADE ${req.url}`);
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
      );
    },
  };
  return { app, reached };
};

describe("Panel server", () => {
  let auth: Auth;
  let origin: string;
  let port: number;
  let reached: string[];
  let reachedMcp: string[];
  let server: Server;

  const send = async ({
    address = "127.0.0.1",
    cookie,
    headers = {},
    host = `${HOSTNAME}:${port}`,
    method = "GET",
    origin: requestOrigin,
    path = "/",
  }: Send = {}): Promise<Response> => {
    const req = request({
      agent: false,
      headers: {
        host,
        ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
      host: address,
      method,
      path,
      port,
      rejectUnauthorized: false,
      servername: HOSTNAME,
    });
    req.end();

    const [res, socket] = (await Promise.race([
      once(req, "response"),
      once(req, "upgrade"),
    ])) as [IncomingMessage, { destroy: () => void } | undefined];
    if (socket !== undefined) {
      socket.destroy();
      return { body: "", headers: res.headers, status: 101 };
    }
    return {
      body: await text(res),
      headers: res.headers,
      status: res.statusCode ?? 0,
    };
  };

  const statusOf = async (options: Send = {}): Promise<number> => {
    const { status } = await send(options);
    return status;
  };

  const login = async (): Promise<string> => {
    const res = await send({
      path: `${LOGIN_PATH}?token=${auth.issueLoginToken()}`,
    });
    const [setCookie] = res.headers["set-cookie"] ?? [];
    return setCookie?.split(";")[0] ?? "";
  };

  const upgradeHeaders = {
    connection: "Upgrade",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    upgrade: "websocket",
  };

  beforeAll(async () => {
    port = await freePort();
    origin = panelOrigin(HOSTNAME, port);
    auth = createAuth();
    const recorded = recordingApp();
    ({ reached } = recorded);
    reachedMcp = [];
    server = createPanelServer({
      app: recorded.app,
      auth,
      hostname: HOSTNAME,
      log: () => {},
      mcp: {
        handle: (req, res, url) => {
          reachedMcp.push(`${req.method} ${url.pathname}`);
          res.end("mcp");
        },
      },
      port,
      tls: await selfSignedCert(HOSTNAME),
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
  });

  afterAll(() => {
    server.close();
  });

  describe("MCP endpoints", () => {
    it("take requests without a session or an Origin, apart from the app", async () => {
      reached.length = 0;
      reachedMcp.length = 0;
      const res = await send({ method: "POST", path: "/mcp/gitlab" });
      expect(res.body).toBe("mcp");
      expect(reachedMcp).toStrictEqual(["POST /mcp/gitlab"]);
      expect(reached).toStrictEqual([]);
    });

    it("refuse a browser on another site, and a foreign Host", async () => {
      reachedMcp.length = 0;
      await expect(
        statusOf({
          method: "POST",
          origin: "https://evil.test",
          path: "/mcp/gitlab",
        })
      ).resolves.toBe(403);
      await expect(
        statusOf({
          host: "evil.test",
          method: "POST",
          path: "/mcp/gitlab",
        })
      ).resolves.toBe(421);
      expect(reachedMcp).toStrictEqual([]);
    });

    it("are only what is under /mcp/", async () => {
      reachedMcp.length = 0;
      await expect(
        statusOf({ method: "POST", path: "/mcpx/gitlab" })
      ).resolves.toBe(403);
      await expect(statusOf({ path: "/mcp" })).resolves.toBe(401);
      expect(reachedMcp).toStrictEqual([]);
    });
  });

  it("asks for a login without a session, and never reaches the app", async () => {
    reached.length = 0;
    const res = await send();

    expect(res.status).toBe(401);
    expect(reached).toStrictEqual([]);
  });

  it("reloads a cross-site navigation, so the browser sends the cookie", async () => {
    reached.length = 0;
    const res = await send({
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('<meta http-equiv="refresh" content="0">');
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^__Host-makak-reload=1;/u);
    expect(reached).toStrictEqual([]);
  });

  it("reloads only once, even if the reload still counts as cross-site", async () => {
    const res = await send({
      headers: {
        cookie: "__Host-makak-reload=1",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(res.status).toBe(401);
  });

  it("asks for a login when a same-site reload still has no session", async () => {
    await expect(
      statusOf({
        headers: {
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
        },
      })
    ).resolves.toBe(401);
  });

  it("exchanges a login token for a session cookie and redirects home", async () => {
    const res = await send({
      path: `${LOGIN_PATH}?token=${auth.issueLoginToken()}`,
    });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["set-cookie"]).toStrictEqual([
      expect.stringMatching(
        new RegExp(
          `^${SESSION_COOKIE}=[\\w-]+; Path=/; HttpOnly; Secure; SameSite=Strict$`,
          "u"
        )
      ),
    ]);
  });

  it("serves the app with a session", async () => {
    const res = await send({ cookie: await login(), path: "/some/page" });

    expect(res.status).toBe(200);
    expect(res.body).toBe("app");
    expect(reached).toContain("GET /some/page");
  });

  it("refuses a login token the second time", async () => {
    const path = `${LOGIN_PATH}?token=${auth.issueLoginToken()}`;
    await send({ path });

    await expect(statusOf({ path })).resolves.toBe(403);
  });

  it("sends a signed-in browser home from a spent login link", async () => {
    const cookie = await login();
    const res = await send({ cookie, path: `${LOGIN_PATH}?token=spent` });

    expect(res.status).toBe(303);
  });

  it("rejects a foreign Host even with a session (DNS rebinding)", async () => {
    reached.length = 0;
    const cookie = await login();

    await expect(statusOf({ cookie, host: `evil.test:${port}` })).resolves.toBe(
      421
    );
    await expect(statusOf({ cookie, host: `localhost:${port}` })).resolves.toBe(
      421
    );
    expect(reached).toStrictEqual([]);
  });

  it.each([
    ["no Origin", undefined],
    ["a sandbox's Origin", "https://feature-a.makak.test"],
    ["the Panel's host on another port", `https://${HOSTNAME}:8000`],
  ])("rejects a POST with %s (CSRF)", async (_, postOrigin) => {
    reached.length = 0;
    const cookie = await login();

    await expect(
      statusOf({ cookie, method: "POST", origin: postOrigin })
    ).resolves.toBe(403);
    expect(reached).toStrictEqual([]);
  });

  it("passes a POST with the Panel's Origin to the app", async () => {
    reached.length = 0;
    const cookie = await login();

    await expect(statusOf({ cookie, method: "POST", origin })).resolves.toBe(
      200
    );
    expect(reached).toStrictEqual(["POST /"]);
  });

  it("sets security headers on every response", async () => {
    const res = await send();

    expect(res.headers).toMatchObject({
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });

  it("answers a request target that is not a URL with 400, and keeps running", async () => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false,
      servername: HOSTNAME,
    });
    await once(socket, "secureConnect");
    socket.end(
      `GET http://[ HTTP/1.1\r\nHost: ${HOSTNAME}:${port}\r\nConnection: close\r\n\r\n`
    );
    const response = await text(socket);

    expect(response).toMatch(/^HTTP\/1\.1 400 /u);
    await expect(statusOf()).resolves.toBe(401);
  });

  it("applies the same checks to WebSocket upgrades", async () => {
    reached.length = 0;
    const cookie = await login();
    const headers = upgradeHeaders;

    await expect(statusOf({ headers, origin })).resolves.toBe(401);
    await expect(
      statusOf({ cookie, headers, origin: "https://feature-a.makak.test" })
    ).resolves.toBe(403);
    expect(reached).toStrictEqual([]);

    await expect(statusOf({ cookie, headers, origin })).resolves.toBe(101);
    expect(reached).toStrictEqual(["UPGRADE /"]);
  });
});

describe("Panel server on a wildcard address", () => {
  const external = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === "IPv4" && !info.internal)?.address;

  it.skipIf(external === undefined)(
    "drops connections from peers that are not loopback",
    async () => {
      const server = createPanelServer({
        app: recordingApp().app,
        auth: createAuth(),
        hostname: HOSTNAME,
        log: () => {},
        port: 0,
        tls: await selfSignedCert(HOSTNAME),
      });
      server.listen(0, "0.0.0.0");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;

      try {
        const socket = connect(port, external);
        socket.on("error", () => {});
        // Without the drop the connection stays open and this times out.
        await once(socket, "close");
        expect(socket.bytesRead).toBe(0);
      } finally {
        server.close();
      }
    }
  );
});
