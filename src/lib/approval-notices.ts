import type { Notice } from "#server/mcp/approval-events.ts";

// Browser notifications about tool calls waiting for the user, while no tab
// of the Panel has focus. The decisions are here; the browser's side is in
// approval-bell.svelte.

/** Where the queue streams from. */
export const EVENTS_PATH = "/mcp-panel/approvals/events";
/** This browser's choice, "on" or "off". */
export const NOTIFY_KEY = "makak:notify";
/** Held by the one tab that notifies. */
export const NOTIFIER_LOCK = "makak:notifier";
/** Where tabs ask each other whether one has focus. */
export const FOCUS_CHANNEL = "makak:focus";
/** How long a tab waits for another to say it has focus. */
export const FOCUS_REPLY_MS = 150;

/**
 * - `off`: not chosen, or the browser hasn't allowed it yet.
 * - `on`: notifying.
 * - `blocked`: the browser's settings deny it; only they can change that.
 * - `stopped`: chosen, but the stream ended for good, e.g. the Panel
 *   restarted and signed this browser out.
 */
export type Bell = "blocked" | "off" | "on" | "stopped";

export const bellOf = ({
  enabled,
  permission,
  stopped,
}: {
  enabled: boolean;
  permission: NotificationPermission;
  stopped: boolean;
}): Bell => {
  if (permission === "denied") {
    return "blocked";
  }
  if (!enabled || permission !== "granted") {
    return "off";
  }
  return stopped ? "stopped" : "on";
};

export const BELLS: Record<Bell, { icon: string; title: string }> = {
  blocked: {
    icon: "🔕",
    title: "Notifications are blocked in this browser's settings for this site",
  },
  off: { icon: "🔕", title: "Notify me when a tool call waits" },
  on: { icon: "🔔", title: "Notifying when a tool call waits; click to stop" },
  stopped: {
    icon: "⚠️",
    title:
      "Not notifying: the Panel restarted or signed this browser out. Reload after signing in.",
  },
};

/**
 * Picks out the requests new to a tab, list by list. Its first list is what
 * waited before it, which the page already shows, so none of it is new.
 * After a reconnect, what came in between is.
 */
export const createNewNotices = () => {
  let known: Set<string> | undefined;
  return (list: readonly Notice[]): Notice[] => {
    const seen = known;
    known = new Set(list.map(({ id }) => id));
    return seen === undefined ? [] : list.filter(({ id }) => !seen.has(id));
  };
};

const isNotice = (value: unknown): value is Notice =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Notice).id === "string" &&
  typeof (value as Notice).server === "string" &&
  typeof (value as Notice).tool === "string";

/** An event's list, or undefined if it isn't one. */
export const parseNotices = (data: string): Notice[] | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  return Array.isArray(value) && value.every(isNotice) ? value : undefined;
};

/** What a notification says: tool and server, never the arguments. */
export const noticeText = ({ server, tool }: Notice) => ({
  body: `${tool} on ${server}`,
  title: "Tool call waiting",
});
