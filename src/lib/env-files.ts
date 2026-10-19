// How sbx combines env files, and the `args:` they declare. Shared by the
// server, which runs `sbx env`, and the create form, which is generated from
// the args of the files selected.

/** An `args:` entry, as far as the form needs it. */
export interface ArgSpec {
  default?: string | undefined;
  description?: string | undefined;
  enum?: string[] | undefined;
  /** An RE2 expression the whole value must match. */
  pattern?: string | undefined;
  required: boolean;
}

/**
 * The arg the Panel fills in with the sandbox name, when the files declare
 * it. There is no built-in reference to the name, and per-sandbox settings
 * such as MCP registrations need one.
 */
export const SANDBOX_ARG = "sandbox";

/** Sandbox names the Panel creates: safe as a flag value and a file name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u;

export const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeTwo = (earlier: unknown, later: unknown): unknown => {
  if (isMap(earlier) && isMap(later)) {
    // fromEntries, so keys such as __proto__ stay plain keys.
    return Object.fromEntries([
      ...Object.entries(earlier).map(([key, value]) => [
        key,
        Object.hasOwn(later, key) ? mergeTwo(value, later[key]) : value,
      ]),
      ...Object.entries(later).filter(([key]) => !Object.hasOwn(earlier, key)),
    ]);
  }
  if (Array.isArray(earlier) && Array.isArray(later)) {
    return [...earlier, ...later];
  }
  return later === undefined ? earlier : later;
};

/**
 * Merges env files the way `sbx env` does: maps merge by key, lists
 * concatenate, and anything else from a later file replaces the earlier value.
 */
export const mergeEnv = (layers: readonly unknown[]): unknown => {
  let merged: unknown;
  for (const layer of layers) {
    merged = mergeTwo(merged, layer);
  }
  return merged;
};

const scalarText = (value: unknown): string | undefined =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : undefined;

/**
 * The `args:` block of a merged env file. Malformed entries are read as far
 * as they go; `sbx env plan` reports what is wrong with them.
 */
export const argSpecs = (env: unknown): Record<string, ArgSpec> => {
  const args = isMap(env) ? env.args : undefined;
  if (!isMap(args)) {
    return {};
  }
  const specs: [string, ArgSpec][] = [];
  for (const [name, declaration] of Object.entries(args)) {
    const spec = isMap(declaration) ? declaration : {};
    specs.push([
      name,
      {
        default: scalarText(spec.default),
        description:
          typeof spec.description === "string" ? spec.description : undefined,
        enum: Array.isArray(spec.enum)
          ? spec.enum.map(scalarText).filter((value) => value !== undefined)
          : undefined,
        pattern: typeof spec.pattern === "string" ? spec.pattern : undefined,
        required: spec.required === true,
      },
    ]);
  }
  return Object.fromEntries(specs);
};

/**
 * An arg's pattern as a JavaScript expression matching the whole value, or
 * undefined when it isn't one. RE2 and JavaScript agree on ordinary patterns;
 * for the rest, `sbx` is the judge.
 */
export const argPattern = (pattern: string): RegExp | undefined => {
  try {
    return new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    return undefined;
  }
};

/** What is wrong with a value for an arg, if anything. Empty means unset. */
export const argError = (
  name: string,
  spec: ArgSpec,
  value: string
): string | undefined => {
  if (value === "") {
    return spec.required ? `${name} is required.` : undefined;
  }
  if (spec.enum !== undefined && !spec.enum.includes(value)) {
    return `${name} must be one of ${spec.enum.join(", ")}.`;
  }
  if (
    spec.pattern !== undefined &&
    argPattern(spec.pattern)?.test(value) === false
  ) {
    return `${name} must match ${spec.pattern}.`;
  }
  return undefined;
};

/** What is wrong with a name for a new sandbox, if anything. */
export const nameError = (name: string): string | undefined =>
  NAME.test(name)
    ? undefined
    : "The name must start with a letter or digit, and have at most 63 letters, digits, dots, dashes and underscores.";
