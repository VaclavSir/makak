import { RUN_ID } from "./runs.ts";

// Which runs a sandbox page shows as tabs, by run id. A running run always
// has one. A finished one keeps its tab until it is closed, and running a
// command again from its tab moves the tab to the new run. Run ids sort by
// the time they started; see newRunId in server/sandbox-runs.ts.

interface ListedRun {
  id: string;
  state: string;
}

/**
 * The tabs to show, in the order they were opened: the open ones that still
 * exist, then the run being viewed, then any other running run. `runs` is
 * every run in the sandbox, or undefined when it couldn't be asked.
 */
export const syncTabs = (
  open: readonly string[],
  runs: readonly ListedRun[] | undefined,
  current?: string
): string[] => {
  // A run newer than every listed one has just started, and isn't listed yet.
  const sorted = (runs ?? []).toSorted((a, b) => a.id.localeCompare(b.id));
  const newest = sorted.at(-1)?.id ?? "";
  const tabs =
    runs === undefined
      ? [...open]
      : open.filter((id) => id > newest || runs.some((run) => run.id === id));
  const add = (id: string) => {
    if (!tabs.includes(id)) {
      tabs.push(id);
    }
  };
  if (current !== undefined) {
    add(current);
  }
  for (const run of sorted) {
    if (run.state === "running") {
      add(run.id);
    }
  }
  return tabs;
};

/** Moves the tab of `from` to `to`, its rerun, keeping its place. */
export const replaceTab = (
  open: readonly string[],
  from: string,
  to: string
): string[] => {
  if (!open.includes(from)) {
    return open.includes(to) ? [...open] : [...open, to];
  }
  return open.filter((id) => id !== to).map((id) => (id === from ? to : id));
};

/** The tab to show after closing `id`: the next one, else the previous. */
export const neighbourTab = (
  tabs: readonly string[],
  id: string
): string | undefined => {
  const index = tabs.indexOf(id);
  if (index === -1) {
    return undefined;
  }
  return tabs[index + 1] ?? tabs[index - 1];
};

/** Open tabs as stored in the browser; anything else counts as none. */
export const parseStoredTabs = (stored: string | null): string[] => {
  if (stored === null) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value)
      ? value.filter(
          (id): id is string => typeof id === "string" && RUN_ID.test(id)
        )
      : [];
  } catch {
    return [];
  }
};

/** The run id a run page's URL names, such as a rerun's redirect. */
export const runIdOf = (location: string): string | undefined => {
  const match = /\/runs\/(?<id>[^/?#]+)\/?(?:[?#].*)?$/u.exec(location);
  if (match === null) {
    return undefined;
  }
  let id: string;
  try {
    id = decodeURIComponent(match.groups?.id ?? "");
  } catch {
    return undefined;
  }
  return RUN_ID.test(id) ? id : undefined;
};
