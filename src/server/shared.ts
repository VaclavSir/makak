// A value that is slow to get, such as `sbx ls`: one load at a time, shared
// by everyone asking, and reused for a moment after it finishes.

export interface Shared<T> {
  /**
   * The value. A load in progress is always shared, however slow, so
   * polling never stacks loads up; a finished one is reused for `ttlMs`.
   * A failure is not kept, so the next call loads again.
   */
  get: () => Promise<T>;
  /** The last value loaded or set since `forget`, and when it came. */
  last: () => { at: number; value: T } | undefined;
  /** Takes a value got some other way as if it had just been loaded. */
  set: (value: T) => void;
  /**
   * Stops reusing a finished value. A load in progress is kept: it is
   * shared, so dropping it would only start a second one.
   */
  expire: () => void;
  /**
   * After the value changed: the next `get` loads afresh, even if a load is
   * in progress, which may predate the change. That load's value is not
   * kept, though its callers still get it.
   */
  forget: () => void;
}

export interface SharedOptions {
  now?: () => number;
  /** How long a finished value is reused. */
  ttlMs: number;
}

export const createShared = <T>(
  load: () => Promise<T>,
  { now = Date.now, ttlMs }: SharedOptions
): Shared<T> => {
  // `at` is when the value came; undefined while it is still loading.
  let current: { at: number | undefined; value: Promise<T> } | undefined;
  let last: { at: number; value: T } | undefined;

  const settle = async (entry: NonNullable<typeof current>) => {
    try {
      const value = await entry.value;
      entry.at = now();
      if (current === entry) {
        last = { at: entry.at, value };
      }
    } catch {
      // The callers see the failure; this only stops it being reused.
      if (current === entry) {
        current = undefined;
      }
    }
  };

  const isFresh = (entry: NonNullable<typeof current>) =>
    entry.at === undefined || now() - entry.at < ttlMs;

  return {
    expire: () => {
      if (current?.at !== undefined) {
        current = undefined;
      }
      last = undefined;
    },
    forget: () => {
      current = undefined;
      last = undefined;
    },
    get: () => {
      if (current === undefined || !isFresh(current)) {
        const entry = { at: undefined, value: load() };
        current = entry;
        void settle(entry);
      }
      return current.value;
    },
    last: () => last,
    set: (value) => {
      const at = now();
      current = { at, value: Promise.resolve(value) };
      last = { at, value };
    },
  };
};
