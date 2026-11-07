import { setImmediate as tick } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { approvalEvents } from "./approval-events.ts";
import { createApprovals } from "./approvals.ts";
import type { Call } from "./approvals.ts";

const CALL: Call = {
  arguments: { iid: 7 },
  server: "gitlab",
  tool: "create_note",
};

/** Reads what the stream sent so far, as text. */
const reading = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (!done) {
      text += decoder.decode(value);
      await pump();
    }
  };
  const finished = pump();
  return { finished, reader, text: () => text };
};

const lists = (text: string) =>
  text
    .split("\n\n")
    .filter((event) => event.startsWith("data: "))
    .map((event) => JSON.parse(event.slice("data: ".length)) as unknown);

describe(approvalEvents, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the list on connect, and again whenever it changes", async () => {
    const approvals = createApprovals();
    const controller = new AbortController();
    const read = reading(
      approvalEvents(approvals, { signal: controller.signal })
    );
    const call = approvals.ask(CALL, { holdMs: 60_000 });
    await tick();
    const [request] = approvals.pending();
    approvals.decide(request?.id ?? "", "approved");
    await call;
    controller.abort();
    await read.finished;

    expect(lists(read.text())).toStrictEqual([
      [],
      [{ id: request?.id, server: "gitlab", tool: "create_note" }],
      [],
    ]);
  });

  it("doesn't send a list for a retry that joins its request", async () => {
    const approvals = createApprovals();
    const controller = new AbortController();
    await approvals.ask(CALL, { holdMs: 1 });
    const read = reading(
      approvalEvents(approvals, { signal: controller.signal })
    );
    await approvals.ask(CALL, { holdMs: 1 });
    controller.abort();
    await read.finished;
    expect(lists(read.text())).toHaveLength(1);
  });

  it("pings, and stops listening once the browser goes away", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn<() => void>();
    const read = reading(
      approvalEvents(
        { pending: () => [], subscribe: () => unsubscribe },
        { pingMs: 1000, signal: new AbortController().signal }
      )
    );
    await vi.advanceTimersByTimeAsync(2500);
    await read.reader.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    await read.finished;
    expect(read.text().match(/: ping\n\n/gu)).toHaveLength(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
