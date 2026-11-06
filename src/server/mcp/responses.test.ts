import { describe, expect, it } from "vitest";

import { cut, MAX_RESPONSE, responseOf } from "./responses.ts";

const answer = (result: unknown, id: unknown = 3) =>
  JSON.stringify({ id, jsonrpc: "2.0", result });

describe(responseOf, () => {
  it("takes the text of a result", () => {
    expect(
      responseOf(
        answer({
          content: [
            { text: "first", type: "text" },
            { data: "…", mimeType: "image/png", type: "image" },
          ],
        }),
        "application/json",
        3,
        true
      )
    ).toStrictEqual({
      error: false,
      text: 'first\n\n{\n  "data": "…",\n  "mimeType": "image/png",\n  "type": "image"\n}',
      truncated: false,
    });
  });

  it("finds the answer in a stream of events, under a string id", () => {
    const body = `event: message\ndata: ${answer({ content: [{ text: "done", type: "text" }], isError: true }, "a")}\n\n`;
    expect(responseOf(body, "text/event-stream", "a", true)).toStrictEqual({
      error: true,
      text: "done",
      truncated: false,
    });
  });

  it("says why a call was refused", () => {
    const body = JSON.stringify({
      error: { code: -32_602, message: "Unknown tool" },
      id: 3,
      jsonrpc: "2.0",
    });
    expect(responseOf(body, "application/json", 3, true)).toStrictEqual({
      error: true,
      text: "Unknown tool",
      truncated: false,
    });
  });

  it("keeps a body it can't read as it came, and only its start", () => {
    expect(responseOf("data: {", "text/event-stream", 3, false)).toStrictEqual({
      error: false,
      text: "data: {",
      truncated: true,
    });
    expect(responseOf("not json", null, 3, true)).toStrictEqual({
      error: false,
      text: "not json",
      truncated: false,
    });
    const long = cut(false, "x".repeat(MAX_RESPONSE + 1));
    expect(long.text).toHaveLength(MAX_RESPONSE);
    expect(long.truncated).toBeTruthy();
  });
});
