import type { Approvals } from "./approvals.ts";

// The approval queue as server-sent events, for the browser to notify about
// new requests while the Panel isn't looked at. Each event is the whole list
// of what waits, sent on connect and whenever it changes, so a reconnect
// needs nothing special: its first event fills any gap.

/** A request waiting, as much of it as a notification says. */
export interface Notice {
  id: string;
  server: string;
  tool: string;
}

/** How often a comment is sent, so a connection gone dead is noticed. */
export const PING_MS = 25_000;

const encoder = new TextEncoder();

/** The requests waiting, oldest first, as notices. */
export const noticesOf = (approvals: Pick<Approvals, "pending">): Notice[] =>
  approvals.pending().map(({ id, server, tool }) => ({ id, server, tool }));

/** The stream, until `signal` aborts or the reader cancels it. */
export const approvalEvents = (
  approvals: Pick<Approvals, "pending" | "subscribe">,
  { pingMs = PING_MS, signal }: { pingMs?: number; signal: AbortSignal }
): ReadableStream<Uint8Array> => {
  const cancelled = new AbortController();
  const until = AbortSignal.any([signal, cancelled.signal]);
  return new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled.abort();
    },
    start: (controller) => {
      if (until.aborted) {
        controller.close();
        return;
      }
      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
      };
      const sendList = () => {
        send(`data: ${JSON.stringify(noticesOf(approvals))}\n\n`);
      };
      const unsubscribe = approvals.subscribe(sendList);
      const timer = setInterval(() => {
        send(": ping\n\n");
      }, pingMs);
      until.addEventListener(
        "abort",
        () => {
          unsubscribe();
          clearInterval(timer);
          // A cancelled stream is closed already.
          if (!cancelled.signal.aborted) {
            controller.close();
          }
        },
        { once: true }
      );
      sendList();
    },
  });
};
