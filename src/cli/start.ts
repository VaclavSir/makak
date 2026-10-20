import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createAuth, LOGIN_PATH } from "../server/auth.ts";
import { loadConfig } from "../server/config.ts";
import type { Config } from "../server/config.ts";
import { setPanelContext } from "../server/context.ts";
import { createLifecycle } from "../server/lifecycle.ts";
import { createPanelServer, panelOrigin } from "../server/panel.ts";
import type { PanelApp } from "../server/panel.ts";
import { createProxyServer } from "../server/proxy/proxy.ts";
import type { ProxyServer } from "../server/proxy/proxy.ts";
import { createSandboxGit } from "../server/sandbox-git.ts";
import { createSandboxRuns } from "../server/sandbox-runs.ts";
import { createSandboxes } from "../server/sandboxes.ts";
import type { Sandboxes } from "../server/sandboxes.ts";
import { createSandboxStore } from "../server/state.ts";
import { createFakeTools, createTools } from "../server/tools/index.ts";
import type { Tools } from "../server/tools/index.ts";

export interface StartOptions {
  configPath?: string;
  dev: boolean;
  fake: boolean;
  open: boolean;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILD_HANDLER = `${ROOT}build/handler.js`;

const log = (message: string) => console.log(`[makak] ${message}`);

const readTlsFile = async (file: string, what: string) => {
  try {
    return await readFile(file);
  } catch (error) {
    throw new Error(
      `Cannot read the ${what} ${file}: ${(error as Error).message}. See docs/setup.md.`,
      { cause: error }
    );
  }
};

const readTls = async (
  { cert, key }: Config["panel"]["tls"],
  owner: string
) => ({
  cert: await readTlsFile(cert, `${owner} TLS certificate`),
  key: await readTlsFile(key, `${owner} TLS key`),
});

/** Binds a server, turning the usual failures into messages that say what to do. */
const bind = async (
  server: Server,
  port: number,
  host: string | undefined,
  what: string
) => {
  server.listen(port, host);
  try {
    await once(server, "listening");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EADDRINUSE") {
      throw new Error(`${what} can't use port ${port}: it is already in use.`, {
        cause: error,
      });
    }
    if (code === "EACCES") {
      throw new Error(
        `${what} can't use port ${port}: permission denied. See docs/configuration.md.`,
        { cause: error }
      );
    }
    throw error;
  }
};

const productionApp = async (origin: string): Promise<PanelApp> => {
  if (!existsSync(BUILD_HANDLER)) {
    throw new Error(
      "No production build found. Run `pnpm build` first, or start with --dev."
    );
  }
  // adapter-node reads ORIGIN at import time to build absolute URLs.
  process.env.ORIGIN = origin;
  const { handler } = (await import(pathToFileURL(BUILD_HANDLER).href)) as {
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      next?: () => void
    ) => void;
  };
  return { handle: (req, res) => handler(req, res) };
};

/**
 * Vite runs inside this process in middleware mode, so dev requests pass the
 * same checks as production. Its HMR WebSocket is attached to a server that
 * never listens; the Panel server hands it upgrades once they pass the checks.
 */
const devApp = async ({
  hostname,
  port,
}: Config["panel"]): Promise<PanelApp> => {
  const { createServer } = await import("vite");
  const hmrServer = createHttpServer();
  const vite = await createServer({
    appType: "custom",
    root: ROOT,
    server: {
      hmr: {
        clientPort: port,
        host: hostname,
        protocol: "wss",
        server: hmrServer,
      },
      middlewareMode: true,
    },
  });
  return {
    close: () => vite.close(),
    handle: (req, res) =>
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    upgrade: (req, socket, head) =>
      hmrServer.emit("upgrade", req, socket, head),
  };
};

const reportTools = async (tools: Tools) => {
  const checks = Object.entries({ git: tools.git, sbx: tools.sbx }).map(
    async ([name, tool]) => {
      try {
        log(`${name}: ${await tool.version()}`);
      } catch (error) {
        log(`warning: ${(error as Error).message}`);
      }
    }
  );
  await Promise.all(checks);
};

/**
 * One server per listener. macOS lets a normal user bind a port below 1024
 * only on the wildcard address, so those bind it, and the proxy drops
 * non-loopback peers itself. The rest bind loopback.
 */
const startProxy = async (
  config: Config,
  origin: string,
  sandboxes: Sandboxes
): Promise<ProxyServer[]> => {
  const { elevate, listeners, suffixes } = config.proxy;
  if (listeners.length === 0) {
    return [];
  }
  const tls = await readTls(config.proxy.tls, "reverse proxy's");
  const proxies: ProxyServer[] = [];
  try {
    for (const listener of listeners) {
      const proxy = createProxyServer({
        elevate,
        listener,
        log,
        panelOrigin: origin,
        sandboxes,
        suffixes,
        tls,
      });
      proxies.push(proxy);
      const host = listener.port < 1024 ? undefined : "127.0.0.1";
      // oxlint-disable-next-line no-await-in-loop -- report the failing port
      await bind(proxy.server, listener.port, host, "The reverse proxy");
      log(
        `Proxy listening on port ${listener.port}, to sandbox port ${listener.upstream.join(" or ")}`
      );
    }
  } catch (error) {
    for (const proxy of proxies) {
      proxy.close();
    }
    throw error;
  }
  return proxies;
};

export const start = async (options: StartOptions): Promise<void> => {
  const config = await loadConfig(options.configPath);
  const { hostname, port } = config.panel;
  const origin = panelOrigin(hostname, port);
  const tls = await readTls(config.panel.tls, "Panel's");
  const tools = options.fake ? createFakeTools() : createTools();
  const auth = createAuth();
  const sandboxes = createSandboxes(tools.sbx);
  const store = createSandboxStore(config.stateDir);
  const sandboxGit = createSandboxGit(tools.git);

  setPanelContext({
    config,
    lifecycle: createLifecycle({
      envDir: config.envDir,
      sandboxGit,
      sandboxes,
      sbx: tools.sbx,
      store,
    }),
    sandboxGit,
    sandboxRuns: createSandboxRuns({
      projects: config.runs.projects,
      runs: tools.runs,
    }),
    sandboxes,
    store,
    tools,
  });
  await reportTools(tools);

  const app = options.dev
    ? await devApp(config.panel)
    : await productionApp(origin);
  const server = createPanelServer({
    app,
    auth,
    hostname,
    log,
    port,
    tls,
  });

  // Loopback only. The hostname resolves to 127.0.0.1; see docs/setup.md.
  await bind(server, port, "127.0.0.1", "The Panel");
  const proxies = await startProxy(config, origin, sandboxes);

  const shutdown = async () => {
    log("Stopping");
    server.close();
    server.closeAllConnections();
    for (const proxy of proxies) {
      proxy.close();
    }
    await app.close?.();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  log(`Panel running at ${origin}${options.dev ? " (dev)" : ""}`);
  const loginUrl = `${origin}${LOGIN_PATH}?token=${auth.issueLoginToken()}`;
  if (options.open) {
    try {
      await tools.browser.open(loginUrl);
      log("Opened the browser. The login link works once, within a minute.");
      return;
    } catch (error) {
      log(`Could not open a browser: ${(error as Error).message}`);
    }
  }
  log(`Log in within a minute: ${loginUrl}`);
};
