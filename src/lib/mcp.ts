// How MCP tool calls are shown for approval: each argument on its own, with
// text as written, so a comment's body reads as the comment it will become.

export interface ArgumentField {
  name: string;
  /** Text as is, or anything else as indented JSON. */
  text: string;
  json: boolean;
}

const asJson = (value: unknown) =>
  JSON.stringify(value, null, 2) ?? "undefined";

export const argumentFields = (args?: unknown): ArgumentField[] => {
  if (args === undefined) {
    return [];
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [{ json: true, name: "", text: asJson(args) }];
  }
  return Object.entries(args).map(([name, value]) =>
    typeof value === "string"
      ? { json: false, name, text: value }
      : { json: true, name, text: asJson(value) }
  );
};

/** The arguments on one line, for the audit log's table. */
export const argumentsSummary = (args?: unknown, max = 120): string => {
  const text = args === undefined ? "" : (JSON.stringify(args) ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export const OUTCOME_LABELS = {
  allowed: "Allowed by the list",
  approved: "Approved",
  denied: "Denied",
  gone: "Gave up waiting",
  held: "Asked to retry",
} as const;

/** A hold time, in the largest unit it is a whole number of. */
export const formatHold = (seconds: number): string => {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds} s`;
};
