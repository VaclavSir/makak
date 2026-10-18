import type { Sandbox, Sbx } from "./tools/index.ts";

export interface Sandboxes {
  /** Every sandbox, sorted by name. */
  list: () => Promise<Sandbox[]>;
  find: (name: string) => Promise<Sandbox | undefined>;
}

export interface SandboxesOptions {
  now?: () => number;
  /** How long a listing is reused. Every open tab polls, and `sbx` is slow. */
  ttlMs?: number;
}

const byName = (a: Sandbox, b: Sandbox) => a.name.localeCompare(b.name);

/**
 * `sbx ls`, shared between concurrent callers and reused for a moment after
 * it finishes. Failures are not cached, so the next call retries.
 */
export const createSandboxes = (
  sbx: Pick<Sbx, "list">,
  { now = Date.now, ttlMs = 2000 }: SandboxesOptions = {}
): Sandboxes => {
  // `at` is when the listing finished; undefined while `sbx` is still running.
  let cached:
    | { at: number | undefined; sandboxes: Promise<Sandbox[]> }
    | undefined;

  const fetchSorted = async () => {
    const sandboxes = await sbx.list();
    return sandboxes.toSorted(byName);
  };

  const settle = async (entry: NonNullable<typeof cached>) => {
    try {
      await entry.sandboxes;
      entry.at = now();
    } catch {
      // The callers see the failure; this only stops it being reused.
      if (cached === entry) {
        cached = undefined;
      }
    }
  };

  // A listing in progress is always shared, however slow `sbx` is, so
  // polling never stacks up `sbx` processes.
  const isFresh = (entry: NonNullable<typeof cached>) =>
    entry.at === undefined || now() - entry.at < ttlMs;

  const list = () => {
    if (cached === undefined || !isFresh(cached)) {
      const entry = { at: undefined, sandboxes: fetchSorted() };
      cached = entry;
      settle(entry);
    }
    return cached.sandboxes;
  };

  return {
    find: async (name) => {
      const sandboxes = await list();
      return sandboxes.find((sandbox) => sandbox.name === name);
    },
    list,
  };
};
