import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import * as z from "zod";

import { createJsonFile } from "../json-file.ts";

// The Panel signs in to MCP servers that use OAuth, once per server, and
// sends that token with every sandbox's calls. The sign-in is MCP's: the
// server's metadata names its authorization server, the Panel registers
// itself there as a client, and signs in with PKCE in the browser.
// Clients and tokens live in `<stateDir>/oauth.json`.

/** Where the browser comes back after signing in: a page of the Panel. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export interface OAuthServer {
  name: string;
  scopes: readonly string[];
  url: string;
}

export interface OAuthStatus {
  signedIn: boolean;
  /** When the access token expires, if the server said. */
  expiresAt?: string;
}

export interface OAuth {
  status: (server: string) => Promise<OAuthStatus>;
  /** Starts a sign-in: where to send the browser. */
  begin: (server: string) => Promise<string>;
  /** The server a sign-in in progress is for, without ending it. */
  pendingServer: (state: string) => string | undefined;
  /** Ends a sign-in with the code the server sent back. Returns the server. */
  finish: (state: string, code: string) => Promise<string>;
  /** A token to send, refreshed when it expires; undefined when signed out. */
  accessToken: (server: string) => Promise<string | undefined>;
  /**
   * A new token, after the server refused `rejected`. When another request
   * has already replaced that token, that one is returned instead.
   */
  refresh: (server: string, rejected?: string) => Promise<string | undefined>;
  signOut: (server: string) => Promise<void>;
}

export class OAuthError extends Error {
  override name = "OAuthError";
}

const clientSchema = z.object({
  authMethod: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  /** The registration is for this callback; the Panel's address may change. */
  redirectUri: z.string(),
  resource: z.string(),
  tokenEndpoint: z.string(),
});

const tokensSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string().optional(),
  refreshToken: z.string().optional(),
});

const fileSchema = z.object({
  servers: z
    .record(
      z.string(),
      z.object({
        client: clientSchema.optional(),
        tokens: tokensSchema.optional(),
      })
    )
    .default({}),
});

type Client = z.output<typeof clientSchema>;

const protectedResourceSchema = z.object({
  authorization_servers: z.array(z.string()).min(1),
  resource: z.string().optional(),
});

const authorizationServerSchema = z.object({
  authorization_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  registration_endpoint: z.string().optional(),
  token_endpoint: z.string(),
});

const registrationSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

/** A sign-in started in the browser and not yet ended. */
interface Pending {
  client: Client;
  expiresAt: number;
  server: string;
  verifier: string;
}

const PENDING_TTL_MS = 10 * 60_000;
/** Tokens are refreshed this long before they expire. */
const EARLY_MS = 60_000;

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const challengeOf = (verifier: string) =>
  base64url(createHash("sha256").update(verifier).digest());

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Endpoints get credentials, so they must be HTTPS, except on this machine. */
const checkedUrl = (value: string, what: string) => {
  const url = URL.parse(value);
  if (
    url === null ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    )
  ) {
    throw new OAuthError(`The ${what} is not an HTTPS URL: ${value}`);
  }
  return url.href;
};

/** `https://host/.well-known/<name>/path`, then `…/<name>` alone. */
const wellKnown = (url: URL, name: string) => {
  const trimmed = url.pathname.replace(/\/$/u, "");
  return trimmed === ""
    ? [`${url.origin}/.well-known/${name}`]
    : [
        `${url.origin}/.well-known/${name}${trimmed}`,
        `${url.origin}/.well-known/${name}`,
      ];
};

/** When the token expires; never, when the server didn't say or it can't be read. */
const expiryOf = (tokens: z.output<typeof tokensSchema>) => {
  const at = Date.parse(tokens.expiresAt ?? "");
  return Number.isNaN(at) ? Infinity : at;
};

const trimmed = (url: string) => url.replace(/\/$/u, "");

/** The `resource_metadata` a 401's `WWW-Authenticate` points to, if any. */
const resourceMetadataOf = (header: string | null) =>
  /resource_metadata="(?<url>[^"]+)"/u.exec(header ?? "")?.groups?.url;

export const createOAuth = ({
  fetch: fetchJson = fetch,
  now = Date.now,
  redirectUri,
  servers,
  stateDir,
}: {
  fetch?: typeof fetch;
  now?: () => number;
  redirectUri: string;
  servers: readonly OAuthServer[];
  stateDir: string;
}): OAuth => {
  const file = createJsonFile(path.join(stateDir, "oauth.json"), fileSchema);
  const pending = new Map<string, Pending>();
  const refreshing = new Map<string, Promise<string | undefined>>();

  const serverOf = (name: string) => {
    const server = servers.find((each) => each.name === name);
    if (server === undefined) {
      throw new OAuthError(`${name} doesn't sign in with OAuth`);
    }
    return server;
  };

  /** A request whose network failure the user is told about. */
  const send = async (url: string, init: RequestInit, what: string) => {
    try {
      return await fetchJson(url, { ...init, redirect: "error" });
    } catch (error) {
      throw new OAuthError(
        `Makak Panel couldn't reach ${what}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  };

  /** JSON from a metadata URL, or undefined for anything else. */
  const getJson = async (url: string): Promise<unknown> => {
    try {
      const response = await fetchJson(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };

  const firstParsed = async <S extends z.ZodType>(
    urls: string[],
    schema: S
  ): Promise<z.output<S> | undefined> => {
    for (const url of urls) {
      // oxlint-disable-next-line no-await-in-loop -- the first that answers
      const parsed = schema.safeParse(await getJson(url));
      if (parsed.success) {
        return parsed.data;
      }
    }
    return undefined;
  };

  /** Where to sign in to the server, from its metadata. */
  const discover = async (server: OAuthServer) => {
    // The metadata decides where the code and verifier go, so it too must
    // come over HTTPS.
    const url = new URL(checkedUrl(server.url, "MCP server's URL"));
    // A 401 may say where its metadata is; otherwise it is at a well-known URL.
    let hinted: string | undefined;
    try {
      const probe = await fetchJson(server.url, {
        body: JSON.stringify({ id: 0, jsonrpc: "2.0", method: "ping" }),
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
      });
      const header = resourceMetadataOf(probe.headers.get("www-authenticate"));
      hinted =
        header === undefined
          ? undefined
          : checkedUrl(header, "resource metadata URL");
      await probe.body?.cancel();
    } catch {
      // The well-known URLs may still answer.
    }
    const resource = await firstParsed(
      [
        ...(hinted === undefined ? [] : [hinted]),
        ...wellKnown(url, "oauth-protected-resource"),
      ],
      protectedResourceSchema
    );
    // The metadata must be for this server, not another on the same host.
    if (
      resource?.resource !== undefined &&
      trimmed(resource.resource) !== trimmed(server.url)
    ) {
      throw new OAuthError(
        `${server.name}'s OAuth metadata is for ${resource.resource}, not for ${server.url}`
      );
    }
    // Servers from before protected resource metadata are their own issuer.
    const issuer = new URL(
      checkedUrl(
        resource?.authorization_servers[0] ?? url.origin,
        "authorization server"
      )
    );
    const metadata = await firstParsed(
      [
        ...wellKnown(issuer, "oauth-authorization-server"),
        ...wellKnown(issuer, "openid-configuration"),
      ],
      authorizationServerSchema
    );
    if (metadata === undefined) {
      throw new OAuthError(
        `${server.name} doesn't say where to sign in: it has no OAuth metadata`
      );
    }
    const methods = metadata.code_challenge_methods_supported;
    if (methods !== undefined && !methods.includes("S256")) {
      throw new OAuthError(`${server.name}'s sign-in doesn't support PKCE`);
    }
    return {
      authorizationEndpoint: checkedUrl(
        metadata.authorization_endpoint,
        "authorization endpoint"
      ),
      registrationEndpoint:
        metadata.registration_endpoint === undefined
          ? undefined
          : checkedUrl(metadata.registration_endpoint, "registration endpoint"),
      resource: resource?.resource ?? server.url,
      tokenEndpoint: checkedUrl(metadata.token_endpoint, "token endpoint"),
    };
  };

  const register = async (
    server: OAuthServer,
    endpoints: Awaited<ReturnType<typeof discover>>
  ): Promise<Client> => {
    if (endpoints.registrationEndpoint === undefined) {
      throw new OAuthError(
        `${server.name} doesn't let clients register themselves, which the Panel needs to sign in`
      );
    }
    const response = await send(
      endpoints.registrationEndpoint,
      {
        body: JSON.stringify({
          client_name: "Makak Panel",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
          response_types: ["code"],
          ...(server.scopes.length > 0
            ? { scope: server.scopes.join(" ") }
            : {}),
          token_endpoint_auth_method: "none",
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      `${server.name}'s sign-in`
    );
    const parsed = registrationSchema.safeParse(
      response.ok ? await response.json() : undefined
    );
    if (!parsed.success) {
      throw new OAuthError(
        `${server.name} refused to register the Panel as a client (HTTP ${response.status})`
      );
    }
    return {
      authMethod: parsed.data.token_endpoint_auth_method ?? "none",
      clientId: parsed.data.client_id,
      clientSecret: parsed.data.client_secret,
      redirectUri,
      resource: endpoints.resource,
      tokenEndpoint: endpoints.tokenEndpoint,
    };
  };

  /** Asks the token endpoint, and keeps what it gives. */
  const requestTokens = async (
    name: string,
    client: Client,
    params: Record<string, string>
  ) => {
    const body = new URLSearchParams({
      ...params,
      resource: client.resource,
    });
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (client.authMethod === "client_secret_basic" && client.clientSecret) {
      const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else {
      body.set("client_id", client.clientId);
      if (client.clientSecret !== undefined) {
        body.set("client_secret", client.clientSecret);
      }
    }
    const response = await send(
      client.tokenEndpoint,
      { body, headers, method: "POST" },
      `${name}'s sign-in`
    );
    const parsed = tokenSchema.safeParse(
      response.ok ? await response.json() : undefined
    );
    if (!parsed.success) {
      return { refused: true, status: response.status } as const;
    }
    const { access_token, expires_in, refresh_token } = parsed.data;
    const tokens = {
      accessToken: access_token,
      expiresAt:
        expires_in === undefined
          ? undefined
          : new Date(now() + expires_in * 1000).toISOString(),
      // A server may keep the refresh token the same and not send it again.
      refreshToken: refresh_token ?? params.refresh_token,
    };
    await file.update((state) => {
      state.servers[name] = { ...state.servers[name], client, tokens };
    });
    return { refused: false, tokens } as const;
  };

  const signOut = async (name: string) => {
    await file.update((state) => {
      const entry = state.servers[name];
      if (entry !== undefined) {
        delete entry.tokens;
      }
    });
  };

  const doRefresh = async (
    name: string,
    rejected?: string
  ): Promise<string | undefined> => {
    const { servers: saved } = await file.read();
    const { client, tokens } = saved[name] ?? {};
    // Another request refreshed it after this one's token was refused.
    if (
      rejected !== undefined &&
      tokens !== undefined &&
      tokens.accessToken !== rejected
    ) {
      return tokens.accessToken;
    }
    if (client === undefined || tokens?.refreshToken === undefined) {
      await signOut(name);
      return undefined;
    }
    const result = await requestTokens(name, client, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });
    if (!result.refused) {
      return result.tokens.accessToken;
    }
    // Refused: the sign-in ended, e.g. revoked, and signing in again is the
    // way back. Anything else may pass, so the sign-in is kept.
    if (result.status === 400 || result.status === 401) {
      await signOut(name);
      return undefined;
    }
    throw new OAuthError(
      `${name} couldn't refresh the Panel's sign-in (HTTP ${result.status}); it will try again with the next call`
    );
  };

  /** One refresh at a time per server, shared by everyone waiting for it. */
  const refresh = (name: string, rejected?: string) => {
    const running = refreshing.get(name);
    if (running !== undefined) {
      return running;
    }
    const next = (async () => {
      try {
        return await doRefresh(name, rejected);
      } finally {
        refreshing.delete(name);
      }
    })();
    refreshing.set(name, next);
    return next;
  };

  const purge = () => {
    for (const [state, entry] of pending) {
      if (entry.expiresAt < now()) {
        pending.delete(state);
      }
    }
  };

  return {
    accessToken: async (name) => {
      const { servers: saved } = await file.read();
      const tokens = saved[name]?.tokens;
      if (tokens === undefined) {
        return;
      }
      return now() < expiryOf(tokens) - EARLY_MS
        ? tokens.accessToken
        : refresh(name);
    },

    begin: async (name) => {
      const server = serverOf(name);
      purge();
      const endpoints = await discover(server);
      const { servers: saved } = await file.read();
      const known = saved[name]?.client;
      const client =
        known?.redirectUri === redirectUri &&
        known.tokenEndpoint === endpoints.tokenEndpoint
          ? known
          : await register(server, endpoints);
      if (client !== known) {
        await file.update((state) => {
          state.servers[name] = { ...state.servers[name], client };
        });
      }

      const verifier = base64url(randomBytes(32));
      const state = base64url(randomBytes(24));
      pending.set(state, {
        client,
        expiresAt: now() + PENDING_TTL_MS,
        server: name,
        verifier,
      });
      const url = new URL(endpoints.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge", challengeOf(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("resource", client.resource);
      if (server.scopes.length > 0) {
        url.searchParams.set("scope", server.scopes.join(" "));
      }
      return url.href;
    },

    finish: async (state, code) => {
      purge();
      const entry = pending.get(state);
      // Once only, and only for a sign-in this Panel started.
      pending.delete(state);
      if (entry === undefined) {
        throw new OAuthError(
          "This sign-in has expired or was already used. Start it again from the MCP servers page."
        );
      }
      let result: Awaited<ReturnType<typeof requestTokens>>;
      try {
        result = await requestTokens(entry.server, entry.client, {
          code,
          code_verifier: entry.verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        });
      } catch (error) {
        // Not answered, so not used: posting it again may work.
        pending.set(state, entry);
        throw error;
      }
      if (result.refused) {
        throw new OAuthError(
          `${entry.server} refused the sign-in (HTTP ${result.status}). Try again.`
        );
      }
      return entry.server;
    },

    pendingServer: (state) => {
      purge();
      return pending.get(state)?.server;
    },

    refresh,

    signOut,

    status: async (name) => {
      const { servers: saved } = await file.read();
      const tokens = saved[name]?.tokens;
      // An expired token that can't be refreshed signs nobody in.
      const usable =
        tokens !== undefined &&
        (tokens.refreshToken !== undefined || now() < expiryOf(tokens));
      return usable
        ? { expiresAt: tokens.expiresAt, signedIn: true }
        : { signedIn: false };
    },
  };
};
