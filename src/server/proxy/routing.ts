export type HostMatch =
  /** Not under any configured suffix. */
  | { type: "none" }
  /** The suffix itself, e.g. `makak.test`. */
  | { type: "bare"; suffix: string }
  | { label: string; suffix: string; type: "sandbox" };

/** The hostname from a `Host` header: lower case, no port, no trailing dot. */
export const hostnameOf = (host: string): string => {
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return hostname.toLowerCase().replace(/\.$/u, "");
};

/**
 * Matches a `Host` header against the sandbox suffixes. The longest suffix
 * wins, so `.makak.test` still works when `.test` is also configured.
 */
export const matchHost = (
  host: string | undefined,
  suffixes: readonly string[]
): HostMatch => {
  if (host === undefined) {
    return { type: "none" };
  }
  const hostname = hostnameOf(host);
  const [suffix] = suffixes
    .filter((candidate) => `.${hostname}`.endsWith(candidate))
    .toSorted((a, b) => b.length - a.length);
  if (suffix === undefined) {
    return { type: "none" };
  }
  if (`.${hostname}` === suffix) {
    return { suffix, type: "bare" };
  }
  const label = hostname.slice(0, -suffix.length);
  // A sandbox is exactly one label under the suffix.
  return label.includes(".")
    ? { type: "none" }
    : { label, suffix, type: "sandbox" };
};
