import { setImmediate as tick } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createApprovals } from "./approvals.ts";
import type { Call } from "./approvals.ts";

const CALL: Call = {
  arguments: { body: "Looks good", iid: 7 },
  server: "gitlab",
  tool: "create_note",
};

const HOLD = { holdMs: 60_000 };
const SHORT = { holdMs: 1 };

describe(createApprovals, () => {
  it("holds a call until it is approved", async () => {
    const approvals = createApprovals();
    const call = approvals.ask(CALL, HOLD);
    await tick();
    const [request] = approvals.pending();
    expect(request).toMatchObject({ tool: "create_note", waiting: true });
    expect(approvals.decide(request?.id ?? "", "approved")).toBeTruthy();
    await expect(call).resolves.toStrictEqual({
      earlier: false,
      id: request?.id,
      outcome: "approved",
    });
    expect(approvals.pending()).toStrictEqual([]);
  });

  it("holds a call until it is denied", async () => {
    const approvals = createApprovals();
    const call = approvals.ask(CALL, HOLD);
    await tick();
    approvals.decide(approvals.pending()[0]?.id ?? "", "denied");
    await expect(call).resolves.toMatchObject({ outcome: "denied" });
  });

  it("keeps a request nobody decided in time", async () => {
    const approvals = createApprovals();
    const held = await approvals.ask(CALL, SHORT);
    expect(held.outcome).toBe("held");
    expect(approvals.pending()).toMatchObject([
      { id: held.id, stopped: "held", waiting: false },
    ]);
  });

  it("applies a decision made after the call stopped waiting to its retry, once", async () => {
    const approvals = createApprovals();
    const held = await approvals.ask(CALL, SHORT);
    expect(approvals.decide(held.id, "approved")).toBeTruthy();
    expect(approvals.pending()).toStrictEqual([]);
    await expect(
      approvals.ask(
        // oxlint-disable-next-line sort-keys -- the same arguments in another order
        { ...CALL, arguments: { iid: 7, body: "Looks good" } },
        SHORT
      )
    ).resolves.toStrictEqual({
      earlier: true,
      id: held.id,
      outcome: "approved",
    });
    await expect(approvals.ask(CALL, SHORT)).resolves.toMatchObject({
      earlier: false,
      outcome: "held",
    });
  });

  it("joins a retry to the request still pending, instead of queueing it twice", async () => {
    const approvals = createApprovals();
    const held = await approvals.ask(CALL, SHORT);
    const retry = approvals.ask(CALL, HOLD);
    await tick();
    expect(approvals.pending()).toMatchObject([{ id: held.id, waiting: true }]);
    approvals.decide(held.id, "denied");
    await expect(retry).resolves.toMatchObject({
      id: held.id,
      outcome: "denied",
    });
  });

  it("tells calls apart by server, tool and arguments", async () => {
    const approvals = createApprovals();
    await approvals.ask(CALL, SHORT);
    await approvals.ask({ ...CALL, server: "linear" }, SHORT);
    await approvals.ask({ ...CALL, tool: "delete_note" }, SHORT);
    await approvals.ask({ ...CALL, arguments: { iid: 8 } }, SHORT);
    expect(approvals.pending()).toHaveLength(4);
  });

  it("keeps the request when the caller hangs up", async () => {
    const approvals = createApprovals();
    const controller = new AbortController();
    const call = approvals.ask(CALL, { ...HOLD, signal: controller.signal });
    await tick();
    controller.abort();
    await expect(call).resolves.toMatchObject({ outcome: "gone" });
    expect(approvals.pending()).toMatchObject([
      { stopped: "gone", waiting: false },
    ]);
  });

  it("says nothing of how a call stopped while one waits again", async () => {
    const approvals = createApprovals();
    await approvals.ask(CALL, SHORT);
    const retry = approvals.ask(CALL, HOLD);
    await tick();
    const [request] = approvals.pending();
    expect(request).toMatchObject({ waiting: true });
    expect(request).not.toHaveProperty("stopped");
    approvals.decide(request?.id ?? "", "denied");
    await retry;
  });

  it("dismisses a request nobody waits for, so its retry asks again", async () => {
    const approvals = createApprovals();
    const held = await approvals.ask(CALL, SHORT);
    expect(approvals.dismiss(held.id)).toBeTruthy();
    expect(approvals.pending()).toStrictEqual([]);
    expect(approvals.decide(held.id, "approved")).toBeFalsy();
    const retry = await approvals.ask(CALL, SHORT);
    expect(retry).toMatchObject({ earlier: false, outcome: "held" });
    expect(retry.id).not.toBe(held.id);
  });

  it("refuses to dismiss a request a call waits for, or one decided", async () => {
    const approvals = createApprovals();
    const call = approvals.ask(CALL, HOLD);
    await tick();
    const id = approvals.pending()[0]?.id ?? "";
    expect(approvals.dismiss(id)).toBeFalsy();
    approvals.decide(id, "approved");
    await call;
    expect(approvals.dismiss(id)).toBeFalsy();
    const held = await approvals.ask({ ...CALL, tool: "delete_note" }, SHORT);
    approvals.decide(held.id, "approved");
    expect(approvals.dismiss(held.id)).toBeFalsy();
    expect(approvals.dismiss("nope")).toBeFalsy();
  });

  it("forgets a decision nobody came back for", async () => {
    let now = 0;
    const approvals = createApprovals({ decidedTtlMs: 1000, now: () => now });
    const held = await approvals.ask(CALL, SHORT);
    approvals.decide(held.id, "approved");
    now = 1001;
    await expect(approvals.ask(CALL, SHORT)).resolves.toMatchObject({
      earlier: false,
      outcome: "held",
    });
  });

  it("refuses to decide a request twice, or one that doesn't exist", async () => {
    const approvals = createApprovals();
    const held = await approvals.ask(CALL, SHORT);
    expect(approvals.decide(held.id, "denied")).toBeTruthy();
    expect(approvals.decide(held.id, "approved")).toBeFalsy();
    expect(approvals.decide("nope", "approved")).toBeFalsy();
  });

  it("tells listeners when a request joins or leaves the queue", async () => {
    const approvals = createApprovals();
    let heard = 0;
    approvals.subscribe(() => {
      throw new Error("A broken listener");
    });
    const stop = approvals.subscribe(() => {
      heard += 1;
    });
    await approvals.ask(CALL, SHORT);
    await approvals.ask(CALL, SHORT);
    approvals.dismiss(approvals.pending()[0]?.id ?? "");
    expect(heard).toBe(2);
    stop();
    await approvals.ask(CALL, SHORT);
    expect(heard).toBe(2);
  });
});
