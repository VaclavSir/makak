import { createHash, randomBytes } from "node:crypto";

// The `__Host-` prefix makes the browser insist on Secure, Path=/ and no Domain,
// so the cookie can only ever belong to the Panel's exact hostname.
export const SESSION_COOKIE = "__Host-makak-session";

export const LOGIN_PATH = "/_makak/login";

const LOGIN_TOKEN_TTL_MS = 60_000;

const randomToken = (): string => randomBytes(32).toString("base64url");

// Secrets are stored hashed, so a lookup's timing reveals nothing about them.
const digest = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

export interface Auth {
  /** A single-use login token for the URL `makak start` opens. */
  issueLoginToken: () => string;
  /** Exchanges a login token for a session id, or returns undefined. */
  redeemLoginToken: (token: string) => string | undefined;
  isValidSession: (sessionId: string) => boolean;
}

/** In-memory auth state. Restarting the Panel signs every browser out. */
export const createAuth = ({
  now = Date.now,
  ttlMs = LOGIN_TOKEN_TTL_MS,
} = {}): Auth => {
  const loginTokens = new Map<string, number>();
  const sessions = new Set<string>();

  return {
    isValidSession: (sessionId) => sessions.has(digest(sessionId)),

    issueLoginToken: () => {
      const token = randomToken();
      loginTokens.set(digest(token), now() + ttlMs);
      return token;
    },

    redeemLoginToken: (token) => {
      const key = digest(token);
      const expiresAt = loginTokens.get(key);
      loginTokens.delete(key);
      if (expiresAt === undefined || now() > expiresAt) {
        return;
      }
      const sessionId = randomToken();
      sessions.add(digest(sessionId));
      return sessionId;
    },
  };
};

export const sessionCookie = (sessionId: string): string =>
  `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict`;

/** All values of the session cookie. There can be several if one was planted. */
export const sessionIdsFromCookieHeader = (header?: string): string[] =>
  (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
    .map((pair) => pair.slice(SESSION_COOKIE.length + 1));
