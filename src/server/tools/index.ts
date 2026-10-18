import { exec as realExec, execChecked } from "./exec.ts";
import type { Exec } from "./exec.ts";
import { FAKE_SANDBOXES, parseSandboxList } from "./sbx.ts";
import type { Sandbox } from "./sbx.ts";

export type { Sandbox } from "./sbx.ts";

// Thin wrappers over host tools. Each method maps to one command, and
// parsing stays next to it. Nothing outside this directory spawns processes.

export interface Sbx {
  /** `sbx ls --json`: every sandbox on the host. */
  list: () => Promise<Sandbox[]>;
  /** `sbx version`, as printed. */
  version: () => Promise<string>;
}

export interface Git {
  /** `git --version`, as printed. */
  version: () => Promise<string>;
}

export interface Browser {
  open: (url: string) => Promise<void>;
}

export interface Tools {
  browser: Browser;
  git: Git;
  sbx: Sbx;
}

// A wedged sbx daemon must not hang every page load.
const SBX_LIST_TIMEOUT_MS = 15_000;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

const browserCommand = (platform: NodeJS.Platform): string | undefined => {
  if (platform === "darwin") {
    return "open";
  }
  if (platform === "linux") {
    return "xdg-open";
  }
  return undefined;
};

export const createTools = (
  exec: Exec = realExec,
  platform: NodeJS.Platform = process.platform
): Tools => ({
  browser: {
    open: async (url) => {
      const command = browserCommand(platform);
      if (command === undefined) {
        throw new Error(`Opening a browser is not supported on ${platform}`);
      }
      await execChecked(exec, command, [url]);
    },
  },
  git: {
    version: async () =>
      firstLine(await execChecked(exec, "git", ["--version"])),
  },
  sbx: {
    list: async () =>
      parseSandboxList(
        await execChecked(exec, "sbx", ["ls", "--json"], {
          timeoutMs: SBX_LIST_TIMEOUT_MS,
        })
      ),
    version: async () => firstLine(await execChecked(exec, "sbx", ["version"])),
  },
});

/**
 * Stand-ins for development without `sbx` and for tests. The browser is real:
 * the fake mode exists to run the Panel, and opening it is part of that.
 */
export const createFakeTools = (browser = createTools().browser): Tools => ({
  browser,
  git: { version: () => Promise.resolve("git version 0.0.0 (fake)") },
  sbx: {
    list: () => Promise.resolve(structuredClone([...FAKE_SANDBOXES])),
    version: () => Promise.resolve("sbx version 0.0.0 (fake)"),
  },
});
