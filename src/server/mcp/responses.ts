import { messageFor, reasonOf } from "./health.ts";

// What a tool call was answered with, as the MCP log shows it: the text of
// the result, rather than the JSON-RPC around it. Cut short, since a result
// can be a whole job log, and it is kept on disk with the call.

/** How much of an answer is kept, in characters. */
export const MAX_RESPONSE = 16 * 1024;

export interface CallResponse {
  /** The call failed, as the server or the Panel said. */
  error: boolean;
  text: string;
  /** Only the start of the answer is kept. */
  truncated: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The text a result's content carries, and anything else as JSON. */
const textOf = (result: Record<string, unknown>) => {
  const { content, structuredContent } = result;
  if (Array.isArray(content) && content.length > 0) {
    return content
      .map((item: unknown) =>
        isRecord(item) && item.type === "text" && typeof item.text === "string"
          ? item.text
          : JSON.stringify(item, null, 2)
      )
      .join("\n\n");
  }
  return JSON.stringify(structuredContent ?? result, null, 2);
};

/** Keeps the start of the text. */
export const cut = (
  error: boolean,
  text: string,
  truncated = false
): CallResponse =>
  text.length > MAX_RESPONSE
    ? { error, text: text.slice(0, MAX_RESPONSE), truncated: true }
    : { error, text, truncated };

/**
 * The answer to the call `id`, from the body the server sent: JSON, or a
 * stream of events. A body that was cut short, or isn't an answer, is kept
 * as it came.
 */
export const responseOf = (
  body: string,
  contentType: string | null,
  id: unknown,
  complete: boolean
): CallResponse => {
  const message = complete ? messageFor(body, contentType, id) : undefined;
  if (message === undefined) {
    return cut(false, body, !complete);
  }
  if (message.error !== undefined) {
    return cut(true, reasonOf(JSON.stringify(message)));
  }
  const result = isRecord(message.result) ? message.result : {};
  return cut(result.isError === true, textOf(result));
};
