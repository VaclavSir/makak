import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { connect as tlsConnect } from "node:tls";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { selfSignedCert } from "../test-support/tls.ts";
import type { Sandbox } from "../tools/index.ts";
import { createProxyServer } from "./proxy.ts";
import type { ProxyServer } from "./proxy.ts";

const PANEL = "https://makakctl.test:7443";
const SUFFIX = ".makak.test";

interface Response {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

const listen = async (server: Server, host = "127.0.0.1") => {
  server.listen(0, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
};

/** Requests to `/slow`, which the upstream never answers. */
const slow: IncomingMessage[] = [];

/** An upstream that describes the request it got, and sets HSTS. */
const describeRequest =
  (scheme: string) => (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/slow") {
      slow.push(req);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });
    res.end(
      JSON.stringify({
        forwardedHost: req.headers["x-forwarded-host"],
        forwardedProto: req.headers["x-forwarded-proto"],
        host: req.headers.host,
        scheme,
        url: req.url,
      })
    );
  };

/** Accepts WebSocket handshakes, then echoes. */
const echoUpgrades =
  (scheme: string) => (_: IncomingMessage, socket: Socket) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nStrict-Transport-Security: max-age=1\r\nX-Scheme: ${scheme}\r\n\r\n`
    );
    socket.on("data", (data) => socket.write(`echo:${data}`));
  };

const sandbox = (
  name: string,
  ports: [sandboxPort: number, hostPort: number][],
  status = "running"
): Sandbox => ({
  agent: "claude",
  createdAt: undefined,
  id: `id-${name}`,
  lastUsedAt: undefined,
  name,
  ports: ports.map(([sandboxPort, hostPort]) => ({
    hostIp: "127.0.0.1",
    hostPort,
    protocol: "tcp4",
    sandboxPort,
  })),
  status,
  workspaces: [],
});

/** Collects what a socket receives, so a test can wait for some of it. */
const received = (socket: Socket) => {
  let data = "";
  socket.on("data", (chunk) => {
    data += String(chunk);
  });
  return async (wanted: string) => {
    while (!data.includes(wanted)) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the next chunk
      await once(socket, "data");
    }
    return data;
  };
};

describe("Reverse proxy", () => {
  const cert = selfSignedCert("*.makak.test");
  const httpUpstream = createHttpServer(describeRequest("http"));
  httpUpstream.on("upgrade", echoUpgrades("http"));
  let httpsUpstream: Server;
  let invalidated = 0;
  let proxy: ProxyServer;
  let port: number;

  const send = async (
    host: string,
    { path = "/", secure = false } = {}
  ): Promise<Response> => {
    const req = (secure ? httpsRequest : httpRequest)({
      agent: false,
      headers: { host },
      host: "127.0.0.1",
      path,
      port,
      rejectUnauthorized: false,
    });
    req.end();
    const [res] = (await once(req, "response")) as [IncomingMessage];
    return {
      body: await text(res),
      headers: res.headers,
      status: res.statusCode ?? 0,
    };
  };

  const json = async (host: string, options?: Parameters<typeof send>[1]) => {
    const { body } = await send(host, options);
    return JSON.parse(body) as Record<string, string>;
  };

  const handshake = async (host: string, secure: boolean) => {
    const socket = secure
      ? tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false })
      : connect(port, "127.0.0.1");
    await once(socket, secure ? "secureConnect" : "connect");
    socket.write(
      `GET /livereload HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
    );
    return socket;
  };

  beforeAll(async () => {
    const tls = await cert;
    httpsUpstream = createHttpsServer(tls, describeRequest("https"));
    httpsUpstream.on("upgrade", echoUpgrades("https"));
    const httpPort = await listen(httpUpstream);
    const httpsPort = await listen(httpsUpstream);
    // Nothing listens on a port that was free a moment ago.
    const closed = createNetServer();
    const closedPort = await listen(closed);
    closed.close();

    const sandboxes = [
      sandbox("web", [[8000, httpPort]]),
      sandbox("secure", [
        [443, httpsPort],
        [8000, httpPort],
      ]),
      sandbox("Shop", [[8000, httpPort]]),
      sandbox("idle", [[8000, httpPort]], "stopped"),
      sandbox("bare", []),
      sandbox("dead", [[8000, closedPort]]),
    ];
    proxy = createProxyServer({
      listener: { port: 443, upstream: [443, 8000], websocket: false },
      log: () => {},
      panelOrigin: PANEL,
      sandboxes: {
        invalidate: () => {
          invalidated += 1;
        },
        recent: () => Promise.resolve(sandboxes),
      },
      suffixes: [".test", SUFFIX],
      tls,
    });
    port = await listen(proxy.server);
  });

  afterAll(() => {
    proxy.close();
    httpUpstream.close();
    httpsUpstream.close();
  });

  it("routes plain HTTP by hostname, keeping the Host header", async () => {
    await expect(json("web.makak.test:443")).resolves.toStrictEqual({
      forwardedHost: "web.makak.test:443",
      forwardedProto: "http",
      host: "web.makak.test:443",
      scheme: "http",
      url: "/",
    });
  });

  it("passes TLS through to an HTTPS upstream, preferring the first candidate", async () => {
    await expect(
      json("secure.makak.test", { secure: true })
    ).resolves.toMatchObject({ forwardedProto: "https", scheme: "https" });
  });

  it("falls back to a later candidate", async () => {
    // `secure` publishes 443 and 8000; `web` only 8000.
    await expect(json("web.makak.test")).resolves.toMatchObject({
      scheme: "http",
    });
  });

  it("keeps the path and query", async () => {
    await expect(
      json("web.makak.test", { path: "/a/b?c=d" })
    ).resolves.toMatchObject({ url: "/a/b?c=d" });
  });

  it("strips HSTS from responses", async () => {
    const { headers } = await send("web.makak.test");
    expect(headers["strict-transport-security"]).toBeUndefined();
  });

  it("matches sandbox names case-insensitively", async () => {
    await expect(send("SHOP.Makak.Test")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("explains a stopped sandbox, with the command that starts it", async () => {
    const { body, status } = await send("idle.makak.test");
    expect(status).toBe(502);
    expect(body).toContain("idle is stopped");
    expect(body).toContain("sbx run --name idle");
    expect(body).toContain(`href="${PANEL}/sandboxes/idle"`);
  });

  it("explains an unpublished port, with the command that publishes it", async () => {
    const { body, status } = await send("bare.makak.test");
    expect(status).toBe(502);
    expect(body).toContain("sbx ports bare --publish 8000");
  });

  it("answers 404 for an unknown sandbox, a foreign host and the bare suffix", async () => {
    const statuses = await Promise.all(
      ["nope.makak.test", "example.com", "makak.test", "a.b.makak.test"].map(
        async (host) => {
          const { status } = await send(host);
          return status;
        }
      )
    );
    expect(statuses).toStrictEqual([404, 404, 404, 404]);
  });

  it("serves its pages with a strict Content-Security-Policy", async () => {
    const { headers } = await send("nope.makak.test");
    expect(headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
  });

  it("answers 502 when the port refuses, and lists sandboxes again", async () => {
    const before = invalidated;
    const { body, status } = await send("dead.makak.test");
    expect(status).toBe(502);
    expect(body).toContain("Can&#39;t reach the server");
    expect(body).toContain("If it serves HTTPS, use https://dead.makak.test/.");
    expect(invalidated).toBe(before + 1);
  });

  it("drops the upstream request quietly when the browser leaves", async () => {
    const before = invalidated;
    const req = httpRequest({
      agent: false,
      headers: { host: "web.makak.test" },
      host: "127.0.0.1",
      path: "/slow",
      port,
    });
    req.on("error", () => {});
    req.end();
    while (slow.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the upstream has it
      await delay(10);
    }
    const [reached] = slow;
    const closed = once(reached?.socket as Socket, "close");
    req.destroy();
    await closed;
    // The proxy's side of the upstream request reports its end a moment later.
    await delay(50);
    expect(invalidated).toBe(before);
  });

  it("says so when an https:// address reaches an HTTP server", async () => {
    const { body, status } = await send("web.makak.test", { secure: true });
    expect(status).toBe(502);
    expect(body).toContain(
      "doesn&#39;t speak HTTPS. Use http://web.makak.test/ instead."
    );
  });

  it.each([
    ["ws", false],
    ["wss", true],
  ])("passes %s WebSockets through", async (_, secure) => {
    const host = secure ? "secure.makak.test" : "web.makak.test";
    const socket = await handshake(host, secure);
    const until = received(socket);
    try {
      const head = await until("\r\n\r\n");
      socket.write("ping");
      const echoed = await until("echo:ping");
      expect(head).toMatch(/^HTTP\/1\.1 101 /u);
      expect(head).toContain(`X-Scheme: ${secure ? "https" : "http"}`);
      expect(head).not.toContain("Strict-Transport-Security");
      expect(echoed).toContain("echo:ping");
    } finally {
      socket.destroy();
    }
  });

  it("refuses a WebSocket handshake it can't route", async () => {
    const socket = await handshake("bare.makak.test", false);
    const response = await received(socket)("--publish");
    expect(response).toMatch(/^HTTP\/1\.1 502 /u);
    expect(response).toContain("sbx ports bare --publish 8000");
  });
});

describe("Reverse proxy on a wildcard address", () => {
  const external = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === "IPv4" && !info.internal)?.address;

  it.skipIf(external === undefined)(
    "drops connections from peers that are not loopback",
    async () => {
      const proxy = createProxyServer({
        listener: { port: 443, upstream: [8000], websocket: false },
        log: () => {},
        panelOrigin: PANEL,
        sandboxes: { invalidate: () => {}, recent: () => Promise.resolve([]) },
        suffixes: [SUFFIX],
        tls: await selfSignedCert("*.makak.test"),
      });
      const port = await listen(proxy.server, "0.0.0.0");

      try {
        const socket = connect(port, external);
        socket.on("error", () => {});
        socket.write("GET / HTTP/1.1\r\nHost: web.makak.test\r\n\r\n");
        // Without the drop the request is answered, with a 404.
        await once(socket, "close");
        expect(socket.bytesRead).toBe(0);
      } finally {
        proxy.close();
      }
    }
  );
});
