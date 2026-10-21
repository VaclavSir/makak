// How the sidebar orders sandboxes. The choice is remembered in the browser.

export const SANDBOX_ORDERS = [
  { label: "Newest", value: "created" },
  { label: "Recently used", value: "recent" },
  { label: "Name", value: "name" },
] as const;

export type SandboxOrder = (typeof SANDBOX_ORDERS)[number]["value"];

export const DEFAULT_ORDER: SandboxOrder = "created";

interface Sortable {
  createdAt: string | undefined;
  lastUsedAt: string | undefined;
  name: string;
}

/** An order as stored in the browser; anything else is the default. */
export const parseOrder = (stored: string | null): SandboxOrder =>
  SANDBOX_ORDERS.find(({ value }) => value === stored)?.value ?? DEFAULT_ORDER;

/** Milliseconds, or -Infinity for a time sbx didn't give, so it sorts last. */
const timeOf = (iso: string | undefined) => {
  const time = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

const byName = (a: Sortable, b: Sortable) => a.name.localeCompare(b.name);

/** Newest first by the given time, then by name. */
const newestBy =
  (time: (sandbox: Sortable) => string | undefined) =>
  (a: Sortable, b: Sortable) => {
    const [ta, tb] = [timeOf(time(a)), timeOf(time(b))];
    if (ta === tb) {
      return byName(a, b);
    }
    return tb > ta ? 1 : -1;
  };

const COMPARE: Record<SandboxOrder, (a: Sortable, b: Sortable) => number> = {
  created: newestBy(({ createdAt }) => createdAt),
  name: byName,
  recent: newestBy(({ lastUsedAt }) => lastUsedAt),
};

export const sortSandboxes = <T extends Sortable>(
  sandboxes: readonly T[],
  order: SandboxOrder
): T[] => sandboxes.toSorted(COMPARE[order]);
