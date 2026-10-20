export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export interface Autosave {
  /** Records a new value and saves it once `delay` passes without another. */
  change: (value: string) => void;
  /** Saves the latest value now. Resolves when the saving stops. */
  flush: () => Promise<void>;
  /** Whether the latest value is neither saved nor being sent. */
  unsent: () => boolean;
}

/**
 * Saves a value a while after it stops changing, one save at a time. A value
 * that changes during a save is saved after it. A failed save is not retried
 * until the value changes again or is flushed, but a newer value still gets
 * its own attempt.
 */
export const createAutosave = ({
  delay,
  initial,
  onstatus,
  save,
}: {
  delay: number;
  initial: string;
  onstatus: (status: AutosaveStatus, message?: string) => void;
  save: (value: string) => Promise<void>;
}): Autosave => {
  let saved = initial;
  let latest = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let sending: string | undefined;

  // Saves until the value stops changing, or until a change is still waiting
  // out its delay.
  const unsaved = () => latest !== saved && timer === undefined;
  const saveAll = async () => {
    while (unsaved()) {
      const value = latest;
      sending = value;
      onstatus("saving");
      try {
        // oxlint-disable-next-line no-await-in-loop -- one save at a time
        await save(value);
        saved = value;
      } catch (error) {
        // A value that changed during the failed save hasn't been tried yet.
        if (latest === value) {
          onstatus(
            "error",
            error instanceof Error ? error.message : "Could not save."
          );
          return;
        }
      } finally {
        sending = undefined;
      }
    }
    onstatus(latest === saved ? "saved" : "pending");
  };

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (running === undefined && latest !== saved) {
      running = (async () => {
        try {
          await saveAll();
        } finally {
          running = undefined;
        }
      })();
    }
    return running ?? Promise.resolve();
  };

  return {
    change: (value) => {
      latest = value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void flush();
      }, delay);
      if (running === undefined) {
        onstatus(latest === saved ? "idle" : "pending");
      }
    },
    flush,
    unsent: () => latest !== saved && latest !== sending,
  };
};
