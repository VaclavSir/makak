import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createAuth, LOGIN_PATH } from "../server/auth.ts";
import { loadConfig } from "../server/config.ts";
import type { Config } from "../server/config.ts";
import { setPanelContext } from "../server/context.ts";
import { createPanelServer, panelOrigin } from "../server/panel.ts";
import type { PanelApp } from "../server/panel.ts";
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
      `Cannot read the Panel's TLS ${what} ${file}: ${(error as Error).message}. See docs/setup.md.`,
      { cause: error }
    );
  }
};

const readTls = async ({ cert, key }: Config["panel"]["tls"]) => ({
  cert: await readTlsFile(cert, "certificate"),
  key: await readTlsFile(key, "key"),
});

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

export const start = async (options: StartOptions): Promise<void> => {
  const config = await loadConfig(options.configPath);
  const { hostname, port } = config.panel;
  const origin = panelOrigin(hostname, port);
  const tls = await readTls(config.panel.tls);
  const tools = options.fake ? createFakeTools() : createTools();
  const auth = createAuth();

  setPanelContext({ config, tools });
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
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Port ${port} is already in use. Is the Panel already running?`,
        { cause: error }
      );
    }
    throw error;
  }

  const shutdown = async () => {
    log("Stopping");
    server.close();
    server.closeAllConnections();
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
