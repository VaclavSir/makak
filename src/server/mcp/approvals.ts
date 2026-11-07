import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Tool calls waiting for the user. A call is held for a while; if nobody
// decides by then, the agent is told to ask again, and the request stays in
// the queue. Deciding it then decides the agent's next identical call.
// Dismissing it takes it off the queue undecided, for an agent that won't
// call again. Kept in memory: restarting the Panel empties the queue.

/** How long a decision on a call that stopped waiting is kept for its retry. */
export const DECIDED_TTL_MS = 24 * 60 * 60_000;

export interface Call {
  arguments: unknown;
  server: string;
  tool: string;
}

export interface Approval extends Call {
  id: string;
  requestedAt: string;
  /** Whether a call is held open for it right now. */
  waiting: boolean;
  /**
   * How its last call stopped waiting, while none waits: the hold ended
   * and the agent was told to ask again, or the caller hung up.
   */
  stopped?: "gone" | "held";
}

/**
 * - `approved`, `denied`: decided while the call waited, or earlier.
 * - `held`: nobody decided in time; the request stays in the queue.
 * - `gone`: the caller hung up first; the request stays in the queue.
 */
export type Outcome = "approved" | "denied" | "gone" | "held";

export interface Answer {
  id: string;
  outcome: Outcome;
  /** Decided before this call came, on a call that had stopped waiting. */
  earlier: boolean;
}

export interface Approvals {
  ask: (
    call: Call,
    options: { holdMs: number; signal?: AbortSignal }
  ) => Promise<Answer>;
  /** Requests nobody has decided yet, oldest first. */
  pending: () => Approval[];
  /** False when there is no such undecided request. */
  decide: (id: string, decision: "approved" | "denied") => boolean;
  /**
   * Forgets an undecided request no call waits for, so no later call gets
   * a decision from it. False when there is no such request.
   */
  dismiss: (id: string) => boolean;
  /**
   * Calls `listener` whenever a request joins or leaves `pending`. Returns
   * a function that stops it.
   */
  subscribe: (listener: () => void) => () => void;
}

interface Entry extends Call {
  decided?: { at: number; decision: "approved" | "denied" };
  id: string;
  key: string;
  requestedAt: Date;
  stopped?: "gone" | "held";
  waiters: Set<(outcome: Outcome) => void>;
}

/** JSON with object keys sorted, so equal arguments give equal keys. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([a], [b]) => (a < b ? -1 : 1))
        )
      : nested
  ) ?? "undefined";

const keyOf = ({ arguments: args, server, tool }: Call) =>
  JSON.stringify([server, tool, canonical(args)]);

export const createApprovals = ({
  decidedTtlMs = DECIDED_TTL_MS,
  now = Date.now,
} = {}): Approvals => {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One listener failing must not hold up a call, or the others.
      }
    }
  };

  const newId = () => {
    let id: string;
    do {
      id = randomBytes(3).toString("hex");
    } while (entries.has(id));
    return id;
  };

  const purge = () => {
    for (const [id, entry] of entries) {
      if (entry.decided && now() - entry.decided.at > decidedTtlMs) {
        entries.delete(id);
      }
    }
  };

  const find = (key: string) =>
    [...entries.values()].find((entry) => entry.key === key);

  const wait = async (entry: Entry, holdMs: number, signal?: AbortSignal) => {
    const decided = Promise.withResolvers<Outcome>();
    entry.waiters.add(decided.resolve);
    const done = new AbortController();
    const until = AbortSignal.any(
      signal ? [signal, done.signal] : [done.signal]
    );
    try {
      const outcome = await Promise.race([
        decided.promise,
        // Rejects when the caller hangs up, or once decided.
        delay(holdMs, "held" as const, { signal: until }).catch(
          () => "gone" as const
        ),
      ]);
      if (outcome === "gone" || outcome === "held") {
        entry.stopped = outcome;
      }
      return outcome;
    } finally {
      done.abort();
      entry.waiters.delete(decided.resolve);
    }
  };

  return {
    ask: async (call, { holdMs, signal }) => {
      purge();
      const key = keyOf(call);
      const known = find(key);
      if (known?.decided) {
        entries.delete(known.id);
        return { earlier: true, id: known.id, outcome: known.decided.decision };
      }
      const entry = known ?? {
        ...call,
        id: newId(),
        key,
        requestedAt: new Date(now()),
        waiters: new Set(),
      };
      entries.set(entry.id, entry);
      if (known === undefined) {
        changed();
      }
      const outcome = await wait(entry, holdMs, signal);
      return { earlier: false, id: entry.id, outcome };
    },

    decide: (id, decision) => {
      purge();
      const entry = entries.get(id);
      if (entry === undefined || entry.decided) {
        return false;
      }
      if (entry.waiters.size > 0) {
        entries.delete(id);
        for (const waiter of entry.waiters) {
          waiter(decision);
        }
      } else {
        entry.decided = { at: now(), decision };
      }
      changed();
      return true;
    },

    dismiss: (id) => {
      purge();
      const entry = entries.get(id);
      if (entry === undefined || entry.decided || entry.waiters.size > 0) {
        return false;
      }
      entries.delete(id);
      changed();
      return true;
    },

    pending: () => {
      purge();
      return [...entries.values()]
        .filter((entry) => !entry.decided)
        .toSorted((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
        .map((entry) => ({
          arguments: entry.arguments,
          id: entry.id,
          requestedAt: entry.requestedAt.toISOString(),
          server: entry.server,
          ...(entry.waiters.size === 0 && entry.stopped !== undefined
            ? { stopped: entry.stopped }
            : {}),
          tool: entry.tool,
          waiting: entry.waiters.size > 0,
        }));
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
