import { settled } from "./promises.ts";
import { createShared } from "./shared.ts";
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
  /**
   * After sbx changed the sandboxes: the next listing starts after this,
   * even if one is in progress, which may predate the change.
   */
  changed: () => void;
}

export interface SandboxesOptions {
  now?: () => number;
  /** How long a listing is reused. Every open tab polls, and `sbx` is slow. */
  ttlMs?: number;
  /** How old a listing `recent` may answer from. */
  maxStaleMs?: number;
}

const byName = (a: Sandbox, b: Sandbox) => a.name.localeCompare(b.name);

/**
 * `sbx ls`, shared between concurrent callers and reused for a moment after
 * it finishes. Failures are not cached, so the next call retries.
 */
export const createSandboxes = (
  sbx: Pick<Sbx, "list">,
  { maxStaleMs = 30_000, now = Date.now, ttlMs = 2000 }: SandboxesOptions = {}
): Sandboxes => {
  const fetchSorted = async () => {
    const sandboxes = await sbx.list();
    return sandboxes.toSorted(byName);
  };
  const listing = createShared(fetchSorted, { now, ttlMs });

  const recent = () => {
    const answer = listing.last();
    // Starts a new listing if this one has expired; its failure is reported
    // to whoever waits for it, so not here.
    const sandboxes = listing.get();
    if (answer === undefined || now() - answer.at >= maxStaleMs) {
      return sandboxes;
    }
    void settled(sandboxes);
    return Promise.resolve(answer.value);
  };

  return {
    changed: listing.forget,
    find: async (name) => {
      const sandboxes = await listing.get();
      return sandboxes.find((sandbox) => sandbox.name === name);
    },
    invalidate: listing.expire,
    list: listing.get,
    recent,
  };
};
