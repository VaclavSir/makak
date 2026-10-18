import { exec as realExec, execChecked } from "./exec.ts";
import type { Exec } from "./exec.ts";

// Thin wrappers over host tools. Each method maps to one command, and
// parsing stays next to it. Nothing outside this directory spawns processes.

export interface Sbx {
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
  sbx: { version: () => Promise.resolve("sbx version 0.0.0 (fake)") },
});
