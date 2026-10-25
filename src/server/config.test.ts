import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, parseConfig } from "./config.ts";

describe(parseConfig, () => {
  it("fills in defaults, with ~ expanded", () => {
    const config = parseConfig({});

    expect(config.panel).toStrictEqual({
      hostname: "makakctl.test",
      port: 7443,
      tls: {
        cert: path.join(homedir(), "makak/tls/panel.pem"),
        key: path.join(homedir(), "makak/tls/panel-key.pem"),
      },
    });
    expect(config.proxy).toStrictEqual({
      elevate: [],
      listeners: [],
      suffixes: [".makak.test"],
      tls: {
        cert: path.join(homedir(), "makak/tls/sandboxes.pem"),
        key: path.join(homedir(), "makak/tls/sandboxes-key.pem"),
      },
    });
    expect(config.ssh).toStrictEqual({ hostSuffix: ".sbx" });
    expect({ mcp: config.mcp, runs: config.runs }).toStrictEqual({
      mcp: { holdSeconds: 240, servers: [] },
      runs: { projects: [] },
    });
    expect({
      envDir: config.envDir,
      handoffsDir: config.handoffsDir,
      stateDir: config.stateDir,
    }).toStrictEqual({
      envDir: path.join(homedir(), "makak/envs"),
      handoffsDir: path.join(homedir(), "makak/handoffs"),
      stateDir: path.join(homedir(), "makak/state"),
    });
  });

  it("accepts a full config", () => {
    const config = parseConfig({
      envDir: "/srv/envs",
      panel: { hostname: "panel.example.test", port: 9443 },
      proxy: {
        listeners: [{ port: 443, upstream: [443, 8000] }],
        suffixes: [".sbx.test", ".client.test.acme.com"],
      },
    });

    expect(config.envDir).toBe("/srv/envs");
    expect(config.proxy.listeners).toStrictEqual([
      { port: 443, upstream: [443, 8000], websocket: false },
    ]);
  });

  it.each([
    ["localhost", "localhost"],
    ["an IP address", "127.0.0.1"],
    ["upper case", "Makak.test"],
  ])("rejects %s as the Panel hostname", (_, hostname) => {
    expect(() => parseConfig({ panel: { hostname } })).toThrow(ConfigError);
  });

  it.each([
    ["equal to a suffix", "makak.test", [".makak.test"]],
    ["under a suffix", "panel.makak.test", [".makak.test"]],
    ["on a suffix's domain", "panel.acme.com", [".client.test.acme.com"]],
  ])("rejects a Panel hostname %s", (_, hostname, suffixes) => {
    expect(() =>
      parseConfig({ panel: { hostname }, proxy: { suffixes } })
    ).toThrow(/Panel hostname/u);
  });

  it("reads commands per project, with the path's ~ expanded", () => {
    const config = parseConfig({
      runs: {
        projects: [
          {
            commands: [{ command: "npm start", label: "Start" }],
            path: "~/Projects/shop",
          },
        ],
      },
    });
    expect(config.runs.projects).toStrictEqual([
      {
        commands: [{ command: "npm start", label: "Start" }],
        path: path.join(homedir(), "Projects/shop"),
      },
    ]);
    expect(() =>
      parseConfig({ runs: { projects: [{ commands: [], path: "/p" }] } })
    ).toThrow(/commands/u);
  });

  it("reads MCP servers, with headers literal or from the environment", () => {
    const config = parseConfig({
      mcp: {
        servers: [
          {
            allow: ["get_issue"],
            headers: {
              Authorization: { env: "GITLAB_MCP_TOKEN" },
              "X-Team": "web",
            },
            name: "gitlab",
            url: "https://gitlab.example.com/api/v4/mcp",
          },
        ],
      },
    });
    expect(config.mcp.servers).toStrictEqual([
      {
        allow: ["get_issue"],
        headers: {
          Authorization: { env: "GITLAB_MCP_TOKEN" },
          "X-Team": "web",
        },
        name: "gitlab",
        url: "https://gitlab.example.com/api/v4/mcp",
      },
    ]);
  });

  it.each([
    ["a hyphen", "git-lab"],
    ["upper case", "GitLab"],
    ["a leading digit", "1gitlab"],
  ])("rejects an MCP server name with %s", (_, name) => {
    expect(() =>
      parseConfig({ mcp: { servers: [{ name, url: "https://x.test/mcp" }] } })
    ).toThrow(/lower-case letters/u);
  });

  it("rejects an MCP server listed twice, or not at an HTTP(S) URL", () => {
    const server = { name: "gitlab", url: "https://x.test/mcp" };
    expect(() => parseConfig({ mcp: { servers: [server, server] } })).toThrow(
      /listed twice/u
    );
    expect(() =>
      parseConfig({
        mcp: { servers: [{ ...server, url: "file:///etc/passwd" }] },
      })
    ).toThrow(ConfigError);
  });

  it("reads MCP servers that sign in with OAuth, without an Authorization header", () => {
    const server = { name: "gitlab", url: "https://gitlab.test/api/v4/mcp" };
    expect(
      parseConfig({
        mcp: { servers: [{ ...server, oauth: { scopes: ["mcp"] } }] },
      }).mcp.servers[0]?.oauth
    ).toStrictEqual({ scopes: ["mcp"] });
    expect(() =>
      parseConfig({
        mcp: {
          servers: [
            { ...server, headers: { authorization: "Bearer x" }, oauth: {} },
          ],
        },
      })
    ).toThrow(/sets the Authorization header itself/u);
  });

  it("rejects relative paths", () => {
    expect(() => parseConfig({ envDir: "makak/envs" })).toThrow(/absolute/u);
  });

  it("rejects listener ports used twice, or by the Panel", () => {
    expect(() =>
      parseConfig({ proxy: { listeners: [{ port: 7443, upstream: [8000] }] } })
    ).toThrow(/already used/u);
    expect(() =>
      parseConfig({
        proxy: {
          listeners: [
            { port: 8000, upstream: [8000] },
            { port: 8000, upstream: [3000] },
          ],
        },
      })
    ).toThrow(/already used/u);
  });

  it("rejects an elevate rule that is not a regular expression", () => {
    expect(() =>
      parseConfig({ proxy: { elevate: [{ sandbox: "client-(" }] } })
    ).toThrow(/regular expression/u);
  });

  it("rejects an elevate rule for a port no listener resolves to", () => {
    expect(() =>
      parseConfig({
        proxy: {
          elevate: [{ port: 443, sandbox: "^client-" }],
          listeners: [{ port: 443, upstream: [8000] }],
        },
      })
    ).toThrow(/must name the sandbox port/u);
  });

  it("rejects a suffix listed twice", () => {
    expect(() =>
      parseConfig({ proxy: { suffixes: [".makak.test", ".makak.test"] } })
    ).toThrow(/listed twice/u);
  });

  it("rejects unknown keys, so typos are not silently ignored", () => {
    expect(() => parseConfig({ panel: { hostnme: "x.test" } })).toThrow(
      ConfigError
    );
  });
});

describe(loadConfig, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "makak-config-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("rejects a named file that does not exist, instead of using defaults", async () => {
    const file = path.join(dir, "missing.json");
    await expect(loadConfig(file)).rejects.toThrow(
      `Config file not found: ${file}`
    );
  });

  it("reads and validates the file", async () => {
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ panel: { port: 9443 } }));
    const config = await loadConfig(file);
    expect(config.panel.port).toBe(9443);
  });

  it("names the file when it is not valid JSON", async () => {
    const file = path.join(dir, "config.json");
    await writeFile(file, "{ nope");
    await expect(loadConfig(file)).rejects.toThrow(file);
  });
});
