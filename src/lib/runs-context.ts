import { createContext } from "svelte";

import type { PackageScripts, RunCommand } from "#server/sandbox-runs.ts";
import type { Run } from "#server/tools/index.ts";

// A sandbox's runs, shared by its pages: the tab bar and history keep the
// list, and the overview starts runs from what can be run.

/** What can be run in a sandbox, and its runs, as its page loads them. */
export interface RunsView {
  commands: RunCommand[];
  error: string | undefined;
  list: Run[] | undefined;
  prompt: boolean;
  scripts: PackageScripts | undefined;
}

export interface RunsContext {
  /** Undefined until the sandbox answers. */
  readonly view: RunsView | undefined;
  /** Set when the sandbox couldn't be asked. */
  readonly failed: boolean;
  /** Every run, newest first, kept current while the page is open. */
  readonly list: Run[] | undefined;
  /** Asks the sandbox for its runs again. */
  refresh: () => Promise<void>;
  /** Gives the tab of `from` to `to`, its rerun, before showing it. */
  rerun: (from: string, to: string) => void;
}

export const [getRunsContext, setRunsContext] = createContext<RunsContext>();
