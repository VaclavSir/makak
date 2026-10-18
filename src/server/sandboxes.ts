import type { Sandbox, Sbx } from "./tools/index.ts";

export interface Sandboxes {
  /** Every sandbox, sorted by name. */
  list: () => Promise<Sandbox[]>;
  find: (name: string) => Promise<Sandbox | undefined>;
  /**
   * Like `list`, but answers from the last listing while a newer one runs,
   * unless it is older than `maxStaleMs` or was invalidated. For the proxy,
   * which must not stall a page's every request on `sbx`.
   */
  recent: () => Promise<Sandbox[]>;
  /** Forgets the cached listing, e.g. when a published port refused a connection. */
  invalidate: () => void;
}

export interface SandboxesOptions {
  now?: () => number;
  /** How long a listing is reused. Every open tab polls, and `sbx` is slow. */
  ttlMs?: number;
  /** How old a listing `recent` may answer from. */
  maxStaleMs?: number;
}

const byName = (a: Sandbox, b: Sandbox) => a.name.localeCompare(b.name);

/** Lets a promise fail without an unhandled rejection. */
const settleQuietly = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch {
    // Reported elsewhere.
  }
};

/**
 * `sbx ls`, shared between concurrent callers and reused for a moment after
 * it finishes. Failures are not cached, so the next call retries.
 */
export const createSandboxes = (
  sbx: Pick<Sbx, "list">,
  { maxStaleMs = 30_000, now = Date.now, ttlMs = 2000 }: SandboxesOptions = {}
): Sandboxes => {
  // `at` is when the listing finished; undefined while `sbx` is still running.
  let cached:
    | { at: number | undefined; sandboxes: Promise<Sandbox[]> }
    | undefined;
  // The last listing that succeeded, for `recent`.
  let last: { at: number; sandboxes: Sandbox[] } | undefined;

  const fetchSorted = async () => {
    const sandboxes = await sbx.list();
    return sandboxes.toSorted(byName);
  };

  const settle = async (entry: NonNullable<typeof cached>) => {
    try {
      const sandboxes = await entry.sandboxes;
      entry.at = now();
      last = { at: entry.at, sandboxes };
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

  const recent = () => {
    const answer = last;
    // Starts a new listing if this one has expired; its failure is reported
    // to whoever waits for it, so not here.
    const listing = list();
    if (answer === undefined || now() - answer.at >= maxStaleMs) {
      return listing;
    }
    settleQuietly(listing);
    return Promise.resolve(answer.sandboxes);
  };

  return {
    find: async (name) => {
      const sandboxes = await list();
      return sandboxes.find((sandbox) => sandbox.name === name);
    },
    invalidate: () => {
      // A listing still running may predate the change, but it is shared,
      // so dropping it would only start a second `sbx ls`.
      if (cached?.at !== undefined) {
        cached = undefined;
      }
      last = undefined;
    },
    list,
    recent,
  };
};
