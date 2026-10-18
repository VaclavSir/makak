import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import {
  Agent as HttpsAgent,
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { createServer as createNetServer } from "node:net";
import type { Server, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { publishCommand, runCommand } from "../../lib/commands.ts";
import {
  hostLabel,
  isElevated,
  resolveUpstream,
} from "../../lib/proxy-urls.ts";
import type { ElevateRule, ProxyListener } from "../../lib/proxy-urls.ts";
import { refuseUpgrade } from "../http.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { isLoopback } from "../security.ts";
import type { Sandbox } from "../tools/index.ts";
import { PAGE_HEADERS, renderPage } from "./pages.ts";
import type { Page } from "./pages.ts";
import { hostnameOf, matchHost } from "./routing.ts";

export interface ProxyOptions {
  elevate: readonly ElevateRule[];
  listener: ProxyListener;
  log: (message: string) => void;
  panelOrigin: string;
  sandboxes: Pick<Sandboxes, "invalidate" | "recent">;
  suffixes: readonly string[];
  tls: { cert: Buffer | string; key: Buffer | string };
}

/** Where a request goes: a sandbox port, published on the host. */
export interface Target {
  /** TLS from the browser, plain HTTP to the sandbox. */
  elevated: boolean;
  host: string;
  port: number;
  sandbox: Sandbox;
  sandboxPort: number;
}

export type Route = { ok: true; target: Target } | { ok: false; page: Page };

// The first byte of a TLS connection: a handshake record.
const TLS_HANDSHAKE = 0x16;

// How long a new connection may stay silent. After the first byte, Node's
// HTTP timeouts apply.
const FIRST_BYTE_TIMEOUT_MS = 10_000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// With `includeSubDomains`, one sandbox could force HTTPS on every sandbox
// hostname, for good: browsers cache the policy.
const STRIPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "strict-transport-security",
]);

/** Sandboxes publish on a host address; a wildcard one is reached on loopback. */
const dialHost = (hostIp: string): string => {
  if (hostIp === "" || hostIp === "0.0.0.0") {
    return "127.0.0.1";
  }
  return hostIp === "::" ? "::1" : hostIp;
};

/** Decides where a request for `host` on this listener goes. */
export const route = async (
  host: string | undefined,
  {
    elevate,
    listener,
    panelOrigin,
    sandboxes,
    suffixes,
  }: Pick<
    ProxyOptions,
    "elevate" | "listener" | "panelOrigin" | "sandboxes" | "suffixes"
  >
): Promise<Route> => {
  const page = (
    status: number,
    title: string,
    message: string,
    more: { command?: string; hint?: string; path?: string } = {}
  ): Route => ({
    ok: false,
    page: {
      command: more.command,
      hint: more.hint,
      message,
      panelUrl: `${panelOrigin}${more.path ?? "/"}`,
      status,
      title,
    },
  });

  const match = matchHost(host, suffixes);
  if (match.type === "none") {
    return page(
      404,
      "Unknown address",
      `${host ?? "A request without a Host header"} is not under a sandbox suffix: ${suffixes.join(", ")}.`
    );
  }
  if (match.type === "bare") {
    return page(
      404,
      "No sandbox in this address",
      `Sandbox addresses look like <sandbox>${match.suffix}. The Makak Panel lists every sandbox with its addresses.`
    );
  }

  let all: Sandbox[];
  try {
    all = await sandboxes.recent();
  } catch (error) {
    return page(503, "Can't list sandboxes", (error as Error).message);
  }
  const found = all.filter(({ name }) => hostLabel(name) === match.label);
  const [sandbox] = found;
  if (sandbox === undefined) {
    return page(404, "No such sandbox", `There is no sandbox ${match.label}.`);
  }
  if (found.length > 1) {
    return page(
      409,
      "Ambiguous sandbox name",
      `${found.map(({ name }) => name).join(", ")} all have the hostname ${match.label}${match.suffix}, because hostnames ignore case. Only a sandbox with a name of its own can be reached here.`
    );
  }

  const { name } = sandbox;
  const path = `/sandboxes/${encodeURIComponent(name)}`;
  if (sandbox.status !== "running") {
    return page(
      502,
      `${name} is ${sandbox.status}`,
      "Start it, then reload this page:",
      { command: runCommand(name), path }
    );
  }

  const { upstream } = listener;
  const resolution = resolveUpstream(sandbox.ports, upstream);
  if (!resolution.ok) {
    const ports =
      upstream.length === 1
        ? `port ${upstream[0]}`
        : `any of the ports this address tries: ${upstream.join(", ")}`;
    return page(
      502,
      "Port not published",
      `${name} doesn't publish ${ports}. Publish port ${resolution.publish}, then reload this page:`,
      {
        command: publishCommand(name, resolution.publish),
        hint: "The server must listen on 0.0.0.0 inside the sandbox, not on 127.0.0.1.",
        path,
      }
    );
  }

  return {
    ok: true,
    target: {
      elevated: isElevated(elevate, name, resolution.port.sandboxPort),
      host: dialHost(resolution.port.hostIp),
      port: resolution.port.hostPort,
      sandbox,
      sandboxPort: resolution.port.sandboxPort,
    },
  };
};

const connectionTokens = (headers: IncomingHttpHeaders) =>
  new Set(
    (headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
  );

/** The request headers for the upstream. `Host` stays as the browser sent it. */
const forwardHeaders = (
  req: IncomingMessage,
  secure: boolean
): OutgoingHttpHeaders => {
  const named = connectionTokens(req.headers);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && !named.has(name)) {
      headers[name] = value;
    }
  }
  headers["x-forwarded-for"] = req.socket.remoteAddress;
  headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = secure ? "https" : "http";
  return headers;
};

const responseHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const named = connectionTokens(headers);
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name) && !named.has(name)) {
      kept[name] = value;
    }
  }
  return kept;
};

const isTlsError = (error: NodeJS.ErrnoException) =>
  error.code === "EPROTO" || (error.code?.startsWith("ERR_SSL_") ?? false);

/**
 * The same address with TLS added or removed. The listener serves both, so
 * the port stays; it is spelled out unless it is the scheme's default.
 */
const otherSchemeUrl = (
  req: IncomingMessage,
  listenerPort: number,
  { secure, upgrade }: { secure: boolean; upgrade: boolean }
) => {
  const tls = !secure;
  const base = upgrade ? "ws" : "http";
  const scheme = tls ? `${base}s` : base;
  const defaultPort = tls ? 443 : 80;
  const port = listenerPort === defaultPort ? "" : `:${listenerPort}`;
  return `${scheme}://${hostnameOf(req.headers.host ?? "")}${port}${req.url}`;
};

const upstreamFailure = (
  error: NodeJS.ErrnoException,
  { elevated, sandbox, sandboxPort }: Target,
  {
    otherScheme,
    panelOrigin,
    secure,
  }: { otherScheme: string; panelOrigin: string; secure: boolean }
): Page => {
  const panelUrl = `${panelOrigin}/sandboxes/${encodeURIComponent(sandbox.name)}`;
  if (secure && !elevated && isTlsError(error)) {
    return {
      hint: "The proxy passes HTTP and HTTPS through as they are; it never adds or removes TLS.",
      message: `The server on port ${sandboxPort} in ${sandbox.name} doesn't speak HTTPS. Use ${otherScheme} instead.`,
      panelUrl,
      status: 502,
      title: "Not an HTTPS server",
    };
  }
  // A plain request to an HTTPS server fails without a telling error.
  let https = secure ? "" : ` If it serves HTTPS, use ${otherScheme}.`;
  if (elevated) {
    https =
      " This port is elevated, so the proxy talks plain HTTP to it; if the server speaks HTTPS itself, remove its proxy.elevate rule.";
  }
  return {
    hint: `Is the server running, and listening on 0.0.0.0 inside the sandbox?${https}`,
    message: `Connecting to port ${sandboxPort} in ${sandbox.name} failed: ${error.message}.`,
    panelUrl,
    status: 502,
    title: "Can't reach the server",
  };
};

const sendPage = (res: ServerResponse, page: Page) => {
  res.writeHead(page.status, PAGE_HEADERS);
  res.end(renderPage(page));
};

/** The upstream's 101 response, as raw bytes for the browser's socket. */
const switchingProtocolsHead = (up: IncomingMessage) => {
  const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
  for (let index = 0; index < up.rawHeaders.length; index += 2) {
    const name = up.rawHeaders[index] ?? "";
    if (name.toLowerCase() !== "strict-transport-security") {
      lines.push(`${name}: ${up.rawHeaders[index + 1]}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
};

export interface ProxyServer {
  /** Stops listening and drops every open connection. */
  close: () => void;
  /** Unbound; the caller binds it. */
  server: Server;
}

/**
 * One reverse proxy listener. It serves plain HTTP and HTTPS on the same port,
 * telling them apart by the first byte, and passes each through to the
 * sandbox as it came: TLS in, TLS out. Only loopback peers are served.
 */
export const createProxyServer = (options: ProxyOptions): ProxyServer => {
  const { listener, log, panelOrigin } = options;
  const httpAgent = new HttpAgent({ keepAlive: true });
  // The sandbox's own certificate can't match its proxy hostname, and the
  // hop is loopback, so it isn't checked.
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    rejectUnauthorized: false,
  });

  const upstreamRequest = (
    req: IncomingMessage,
    target: Target,
    secure: boolean,
    upgrade: boolean
  ) => {
    // The browser's scheme, which an elevated upstream must also see.
    const headers = forwardHeaders(req, secure);
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = req.headers.upgrade;
    }
    const overTls = secure && !target.elevated;
    // An upgraded connection is never returned to a pool.
    const agent = overTls ? httpsAgent : httpAgent;
    return (overTls ? httpsRequest : httpRequest)({
      agent: upgrade ? false : agent,
      headers,
      host: target.host,
      method: req.method,
      path: req.url,
      port: target.port,
      rejectUnauthorized: false,
    });
  };

  const failed = (target: Target, error: Error) => {
    log(
      `Proxy: ${target.sandbox.name}:${target.sandboxPort} failed: ${error.message}`
    );
    // Ports change when a sandbox is recreated; don't route on a stale list.
    options.sandboxes.invalidate();
  };

  const serve = async (
    req: IncomingMessage,
    res: ServerResponse,
    secure: boolean
  ) => {
    // The browser may leave at any point, even while the route is looked up.
    // Errors after that are ours, not the sandbox's.
    let gone = false;
    res.on("close", () => {
      gone = !res.writableFinished;
    });

    const result = await route(req.headers.host, options);
    if (gone) {
      return;
    }
    if (!result.ok) {
      sendPage(res, result.page);
      return;
    }
    const { target } = result;
    if (target.elevated && !secure) {
      // A plain request would lose the secure context the rule is for.
      // Temporary, so removing the rule takes effect at once.
      res.writeHead(307, {
        "Cache-Control": "no-store",
        Location: otherSchemeUrl(req, listener.port, {
          secure,
          upgrade: false,
        }),
      });
      res.end();
      return;
    }
    const upstream = upstreamRequest(req, target, secure, false);
    res.on("close", () => {
      if (gone) {
        upstream.destroy();
      }
    });
    upstream.on("response", (up) => {
      res.writeHead(
        up.statusCode ?? 502,
        up.statusMessage,
        responseHeaders(up.headers)
      );
      up.on("error", () => res.destroy());
      up.pipe(res);
    });
    upstream.on("error", (error) => {
      if (gone) {
        return;
      }
      failed(target, error);
      if (res.headersSent) {
        res.destroy();
      } else {
        sendPage(
          res,
          upstreamFailure(error, target, {
            otherScheme: otherSchemeUrl(req, listener.port, {
              secure,
              upgrade: false,
            }),
            panelOrigin,
            secure,
          })
        );
      }
    });
    req.pipe(upstream);
  };

  const tunnel = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    secure: boolean
  ) => {
    let gone = false;
    socket.on("close", () => {
      gone = true;
    });

    const result = await route(req.headers.host, options);
    if (gone) {
      return;
    }
    if (!result.ok) {
      const { command, message, status, title } = result.page;
      const fix = command === undefined ? "" : `\n${command}`;
      refuseUpgrade(socket, status, `${title}: ${message}${fix}`);
      return;
    }
    const { target } = result;
    if (target.elevated && !secure) {
      refuseUpgrade(
        socket,
        403,
        `Port ${target.sandboxPort} in ${target.sandbox.name} is elevated to TLS. Use ${otherSchemeUrl(req, listener.port, { secure, upgrade: true })}.`
      );
      return;
    }
    const upstream = upstreamRequest(req, target, secure, true);
    socket.on("close", () => upstream.destroy());
    upstream.on("upgrade", (up, upSocket, upHead) => {
      socket.write(switchingProtocolsHead(up));
      socket.write(upHead);
      upSocket.write(head);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    // The upstream answered without upgrading.
    upstream.on("response", (up) => {
      up.resume();
      refuseUpgrade(
        socket,
        up.statusCode ?? 502,
        `The server in ${target.sandbox.name} refused the WebSocket handshake.`
      );
    });
    upstream.on("error", (error) => {
      if (gone) {
        return;
      }
      failed(target, error);
      const { hint, message, status } = upstreamFailure(error, target, {
        otherScheme: otherSchemeUrl(req, listener.port, {
          secure,
          upgrade: true,
        }),
        panelOrigin,
        secure,
      });
      refuseUpgrade(socket, status, `${message}\n${hint}`);
    });
    upstream.end();
  };

  const upgradeHandler =
    (secure: boolean) =>
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      tunnel(req, socket, head, secure);
    };

  // Neither listens; connections are handed to them below.
  const plain = createHttpServer((req, res) => {
    serve(req, res, false);
  });
  plain.on("upgrade", upgradeHandler(false));
  const tls = createHttpsServer(options.tls, (req, res) => {
    serve(req, res, true);
  });
  tls.on("upgrade", upgradeHandler(true));

  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    // Before anything else: a wildcard bind reaches this from the network.
    if (!isLoopback(socket.remoteAddress)) {
      log(`Proxy: dropped connection from ${socket.remoteAddress}`);
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => socket.destroy());
    socket.once("data", (chunk: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === TLS_HANDSHAKE ? tls : plain).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
  });

  return {
    close: () => {
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      httpAgent.destroy();
      httpsAgent.destroy();
    },
    server,
  };
};
