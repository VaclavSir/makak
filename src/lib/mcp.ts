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

/** A tool as the servers list shows it. */
export interface ToolRow {
  /** Who lets it run without asking: the config, _Always allow_, or nobody. */
  allowed: "always" | "config" | undefined;
  description: string | undefined;
  /** Whether the server's last check listed it. */
  listed: boolean;
  name: string;
  readOnly: boolean;
}

/**
 * The server's tools as its last check listed them, then the allowed ones it
 * didn't list, such as a renamed tool, or all of them before any check.
 */
export const toolRows = (
  listed: readonly {
    description: string | undefined;
    name: string;
    readOnly: boolean;
  }[],
  allow: readonly string[],
  always: readonly string[]
): ToolRow[] => {
  const allowedBy = (name: string) => {
    if (allow.includes(name)) {
      return "config" as const;
    }
    return always.includes(name) ? ("always" as const) : undefined;
  };
  const names = new Set(listed.map(({ name }) => name));
  const unlisted = [...new Set([...allow, ...always])].filter(
    (name) => !names.has(name)
  );
  return [
    ...listed.map((tool) => ({
      ...tool,
      allowed: allowedBy(tool.name),
      listed: true,
    })),
    ...unlisted.map((name) => ({
      allowed: allowedBy(name),
      description: undefined,
      listed: false,
      name,
      readOnly: false,
    })),
  ];
};

/** An MCP server a sandbox can be given. */
export interface McpChoice {
  name: string;
  /** Why it can't be loaded now, if it can't. */
  problem: string | undefined;
}
