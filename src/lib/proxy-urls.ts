// How the reverse proxy maps a sandbox's hostnames and ports. Shared by the
// proxy itself and the Panel, which lists the URLs it serves.

export interface ProxyListener {
  port: number;
  /** Container ports to try, in order. */
  upstream: number[];
  /**
   * For WebSockets, such as livereload: the Panel shows a `wss://` address to
   * copy instead of a link. The proxy serves it like any other listener.
   */
  websocket: boolean;
}

export interface ProxySettings {
  listeners: ProxyListener[];
  suffixes: string[];
}

/** The part of a published port the proxy cares about. */
export interface PortMapping {
  protocol: string;
  sandboxPort: number;
}

/** One lower-case DNS label, as a regular expression source. */
export const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

const LABEL = new RegExp(`^${DNS_LABEL}$`, "u");

/**
 * The sandbox's name as a DNS label, or undefined when it can't be one.
 * Hostnames are case-insensitive, so the label is lower case.
 */
export const hostLabel = (name: string): string | undefined => {
  const label = name.toLowerCase();
  return LABEL.test(label) ? label : undefined;
};

export type Resolution<Port extends PortMapping> =
  | { ok: true; port: Port }
  /** Nothing published; `publish` is the declared default, the last candidate. */
  | { ok: false; publish: number };

/** The first candidate the sandbox publishes over TCP. */
export const resolveUpstream = <Port extends PortMapping>(
  ports: readonly Port[],
  upstream: readonly number[]
): Resolution<Port> => {
  for (const candidate of upstream) {
    const port = ports.find(
      ({ protocol, sandboxPort }) =>
        sandboxPort === candidate && protocol.startsWith("tcp")
    );
    if (port !== undefined) {
      return { ok: true, port };
    }
  }
  return { ok: false, publish: upstream.at(-1) ?? 0 };
};

export interface SandboxUrl {
  listener: ProxyListener;
  resolution: Resolution<PortMapping>;
  url: string;
}

/**
 * Every URL the proxy serves for a sandbox: one per suffix and listener.
 * Undefined when the name can't be used in a hostname.
 */
export const sandboxUrls = (
  name: string,
  ports: readonly PortMapping[],
  { listeners, suffixes }: ProxySettings
): SandboxUrl[] | undefined => {
  const label = hostLabel(name);
  if (label === undefined) {
    return undefined;
  }
  return suffixes.flatMap((suffix) =>
    listeners.map((listener) => {
      const scheme = listener.websocket ? "wss" : "https";
      const port = listener.port === 443 ? "" : `:${listener.port}`;
      return {
        listener,
        resolution: resolveUpstream(ports, listener.upstream),
        url: `${scheme}://${label}${suffix}${port}/`,
      };
    })
  );
};
