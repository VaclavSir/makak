import type { OAuth } from "./oauth.ts";
import type { McpServer } from "./proxy.ts";

// Requests to a wrapped server, with the server's credentials: its configured
// headers, or the Panel's OAuth token, refreshed once when the server refuses
// it. The proxy and the server checks both send through this.

/** The server needs a sign-in the Panel doesn't have. */
export class SignedOutError extends Error {
  override name = "SignedOutError";
}

/**
 * Why a request failed. Node's fetch says only "fetch failed", and keeps the
 * reason, such as a refused connection, as the cause.
 */
export const failureOf = (error: unknown): string => {
  const { cause, message } = error as Error;
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : message;
};

export interface UpstreamRequest {
  body?: string;
  /** Without credentials: the server's own are added. */
  headers: Record<string, string>;
  method: string;
  signal?: AbortSignal;
}

export type Upstream = (
  server: McpServer,
  request: UpstreamRequest
) => Promise<Response>;

export const createUpstream =
  ({
    fetch: fetchUpstream = fetch,
    oauth,
  }: {
    fetch?: typeof fetch;
    oauth?: Pick<OAuth, "accessToken" | "refresh" | "signOut">;
  }): Upstream =>
  async (server, { body, headers, method, signal }) => {
    const sent = { ...headers, ...server.headers };
    const send = async (token: string | undefined) => {
      if (server.oauth !== undefined) {
        if (token === undefined) {
          throw new SignedOutError();
        }
        sent.authorization = `Bearer ${token}`;
      }
      return await fetchUpstream(server.url, {
        body,
        headers: sent,
        method,
        // A redirect is passed back, never followed with the server's headers.
        redirect: "manual",
        signal,
      });
    };
    const token = await oauth?.accessToken(server.name);
    const response = await send(token);
    // A token the server refuses may only need refreshing; once.
    if (response.status !== 401 || server.oauth === undefined) {
      return response;
    }
    await response.body?.cancel();
    const fresh = await send(await oauth?.refresh(server.name, token));
    if (fresh.status === 401) {
      // Refused even fresh: the sign-in is no good, and the page says so.
      await fresh.body?.cancel();
      await oauth?.signOut(server.name);
      throw new SignedOutError();
    }
    return fresh;
  };
