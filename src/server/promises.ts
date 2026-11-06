// Small helpers for waiting on work in the server.

/** Waits for a promise without failing: its failure is reported elsewhere. */
export const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Reported to whoever waited for it.
  }
};

/** Runs a follow-up whose failure must not hide the outcome before it. */
export const quietly = async (
  followUp: () => Promise<unknown>
): Promise<void> => {
  try {
    await followUp();
  } catch {
    // The earlier outcome is what the user needs to see.
  }
};

/**
 * Like `Promise.all` over `items.map(map)`, with at most `limit` running at
 * once, e.g. so a page load can't start a process per branch all together.
 */
export const mapLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // oxlint-disable-next-line no-await-in-loop -- one at a time per worker
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};
