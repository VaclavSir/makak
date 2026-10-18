import { STATUS_CODES } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { Server } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import {
  LOGIN_PATH,
  sessionCookie,
  sessionIdsFromCookieHeader,
} from "./auth.ts";
import type { Auth } from "./auth.ts";
import { allowedHosts, checkRequest, isLoopback } from "./security.ts";
import type { Expectations } from "./security.ts";

/** What the Panel server wraps: SvelteKit's handler, in production or dev. */
export interface PanelApp {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close?: () => Promise<void>;
}

export interface PanelServerOptions {
  app: PanelApp;
  auth: Auth;
  hostname: string;
  log: (message: string) => void;
  port: number;
  tls: { cert: Buffer | string; key: Buffer | string };
}

export const panelOrigin = (hostname: string, port: number): string =>
  port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`;

const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  // Login URLs carry a token; never leak them, or anything else, via Referer.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const sendText = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
};

const redirectHome = (res: ServerResponse) => {
  res.writeHead(303, { Location: "/" });
  res.end();
};

const rejectUpgrade = (socket: Duplex, status: number) => {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`
  );
};

/**
 * The Panel's HTTPS server. Every request passes the checks in security.ts and
 * needs a session, except the login link that creates one. Only then does it
 * reach the app. The server is returned unbound; the caller binds it to loopback.
 */
export const createPanelServer = ({
  app,
  auth,
  hostname,
  log,
  port,
  tls,
}: PanelServerOptions): Server => {
  const origin = panelOrigin(hostname, port);
  const expected: Expectations = {
    hosts: allowedHosts(hostname, port),
    origin,
  };

  const verdictFor = (req: IncomingMessage, upgrade: boolean) =>
    checkRequest(
      {
        host: req.headers.host,
        method: req.method,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
        upgrade,
      },
      expected
    );

  const hasSession = (req: IncomingMessage) =>
    sessionIdsFromCookieHeader(req.headers.cookie).some((id) =>
      auth.isValidSession(id)
    );

  const login = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    res.setHeader("Cache-Control", "no-store");
    const token = url.searchParams.get("token");
    const sessionId = token ? auth.redeemLoginToken(token) : undefined;
    if (sessionId) {
      res.setHeader("Set-Cookie", sessionCookie(sessionId));
      redirectHome(res);
    } else if (hasSession(req)) {
      redirectHome(res);
    } else {
      sendText(
        res,
        403,
        "This login link is invalid or has expired. Login links work once, within a minute. Restart `makak start` to get a new one."
      );
    }
  };

  const server = createServer(tls, (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }

    const verdict = verdictFor(req, false);
    if (!verdict.ok) {
      log(`Rejected ${req.method} ${req.url}: ${verdict.reason}`);
      sendText(res, verdict.status, STATUS_CODES[verdict.status] ?? "Error");
      return;
    }

    // A request target that is not a valid URL must not take the process down.
    const url = URL.parse(req.url ?? "/", origin);
    if (url === null) {
      sendText(res, 400, "Bad Request");
      return;
    }
    if (url.pathname === LOGIN_PATH) {
      login(req, res, url);
      return;
    }

    if (!hasSession(req)) {
      sendText(
        res,
        401,
        "Not signed in. Open the login link from `makak start`, or restart it to get a new one."
      );
      return;
    }

    app.handle(req, res);
  });

  // Before TLS and before any parsing: drop peers that are not loopback.
  server.on("connection", (socket: Socket) => {
    if (!isLoopback(socket.remoteAddress)) {
      log(`Dropped connection from ${socket.remoteAddress}`);
      socket.destroy();
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const verdict = verdictFor(req, true);
    if (!verdict.ok) {
      log(`Rejected upgrade ${req.url}: ${verdict.reason}`);
      rejectUpgrade(socket, verdict.status);
    } else if (!hasSession(req)) {
      rejectUpgrade(socket, 401);
    } else if (app.upgrade) {
      app.upgrade(req, socket, head);
    } else {
      rejectUpgrade(socket, 404);
    }
  });

  return server;
};
