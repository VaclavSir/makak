// Request checks that run before anything else sees a request.
// Kept free of I/O, so every rule is unit-testable.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export const isLoopback = (address: string | undefined): boolean =>
  address !== undefined && LOOPBACK.has(address);

/** The `Host` header values a client may send to reach the Panel. */
export const allowedHosts = (hostname: string, port: number): string[] =>
  port === 443 ? [hostname, `${hostname}:443`] : [`${hostname}:${port}`];

export interface RequestFacts {
  /**
   * Authenticated by a bearer token, not the session cookie, as the MCP
   * endpoints are. A browser never sends one by itself, so another site can't
   * make it act; but a browser's request always has an Origin, and only the
   * Panel's is let through.
   */
  bearer?: boolean;
  host: string | undefined;
  method: string | undefined;
  origin: string | undefined;
  remoteAddress: string | undefined;
  /** WebSocket handshakes are GETs, but browsers do not apply CORS to them. */
  upgrade: boolean;
}

export interface Expectations {
  hosts: readonly string[];
  origin: string;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; status: 403 | 421 };

/**
 * - Peer must be loopback: binding loopback is the main control, this is the backstop.
 * - Host must be the Panel's own, which stops DNS rebinding.
 * - Origin must be the Panel's own for anything that can change state, which stops CSRF.
 *   GET and HEAD never change state, and CORS keeps their responses from other origins.
 *   Requests with a bearer token may have no Origin, as no browser sent them.
 */
export const checkRequest = (
  facts: RequestFacts,
  expected: Expectations
): Verdict => {
  if (!isLoopback(facts.remoteAddress)) {
    return { ok: false, reason: "not a loopback peer", status: 403 };
  }

  const host = facts.host?.toLowerCase();
  if (host === undefined || !expected.hosts.includes(host)) {
    return { ok: false, reason: "unexpected Host header", status: 421 };
  }

  const needsOrigin =
    facts.upgrade || !SAFE_METHODS.has(facts.method?.toUpperCase() ?? "");
  const foreignOrigin = facts.bearer
    ? facts.origin !== undefined && facts.origin !== expected.origin
    : needsOrigin && facts.origin !== expected.origin;
  if (foreignOrigin) {
    return { ok: false, reason: "missing or foreign Origin", status: 403 };
  }

  return { ok: true };
};
