import type { Config } from "./config.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { SandboxGit } from "./sandbox-git.ts";
import type { SandboxRuns } from "./sandbox-runs.ts";
import type { Sandboxes } from "./sandboxes.ts";
import type { SandboxStore } from "./state.ts";
import type { Tools } from "./tools/index.ts";

/** What SvelteKit routes get from the process that started the Panel. */
export interface PanelContext {
  config: Config;
  lifecycle: Lifecycle;
  sandboxGit: SandboxGit;
  sandboxRuns: SandboxRuns;
  sandboxes: Sandboxes;
  store: SandboxStore;
  tools: Tools;
}

// SvelteKit's server code is bundled (or, in dev, loaded by Vite) separately
// from the process's own modules, so it gets its own copy of this file.
// globalThis is the one thing both copies share.
const KEY = Symbol.for("makak.panel-context");

type Global = Record<symbol, PanelContext | undefined>;

export const setPanelContext = (context: PanelContext): void => {
  (globalThis as Global)[KEY] = context;
};

export const getPanelContext = (): PanelContext => {
  const context = (globalThis as Global)[KEY];
  if (context === undefined) {
    throw new Error(
      "The Panel context is missing. Start the Panel with `makak start`, not with Vite directly."
    );
  }
  return context;
};
