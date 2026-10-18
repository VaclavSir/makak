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
        cert: path.join(homedir(), ".makak/tls/panel.pem"),
        key: path.join(homedir(), ".makak/tls/panel-key.pem"),
      },
    });
    expect(config.proxy).toStrictEqual({
      listeners: [],
      suffixes: [".makak.test"],
    });
    expect(config.envDir).toBe(path.join(homedir(), "makak/envs"));
    expect(config.handoffsDir).toBe(path.join(homedir(), "makak/handoffs"));
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
      { port: 443, upstream: [443, 8000] },
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
