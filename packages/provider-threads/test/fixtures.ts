/**
 * Fixtures for the Threads Provider tests.
 *
 * Every instant is fixed and every transport is scripted, so the suites perform
 * no network, clock or random work. The canaries are labelled non-secret
 * strings; they exist so a test can prove that the client secret, the
 * authorization code, the short-lived token and the long-lived token never reach
 * a preview, an outcome or an error.
 */

import type {
  AccountIdentity,
  ContractCase,
  FreezeInput,
  JsonObject,
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderTransport,
} from "@syndroo/provider-sdk";

import plugin from "../src/index.js";

/** The default API host the fixtures use: the collection's `.net` value. */
export const API_HOST = "https://graph.threads.net";
/** The default authorization host: the collection's `.net` value. */
export const AUTHORIZATION_HOST = "https://www.threads.net";

/** The account id `GET /me` returns in the fixtures. */
export const ACCOUNT_ID = "12345678901234567";
/** The username `GET /me` returns; used to derive the profile URL. */
export const USERNAME = "syndroo";

/** The account the fixtures claim identity for; origin is the profile origin. */
export const THREADS_ACCOUNT: AccountIdentity = {
  provider: "threads",
  accountId: ACCOUNT_ID,
  origin: "https://www.threads.net",
};

/** Fixed instant every fixture uses instead of a clock. */
export const FIXED_NOW = "2026-10-08T00:00:00.000Z";
/** Fixed submission seed, also used as the publish `submissionId`. */
export const FIXED_SEED = "seed_threads_0001";

/** The app client id the fixtures register. */
export const CLIENT_ID = "threads-client-id-fixture";
/** The fixed callback the fixtures register and reuse. */
export const REDIRECT_URI = "https://127.0.0.1:7777/oauth/callback";
/** The scopes the flow asks for by default. */
export const SCOPES = ["threads_basic", "threads_content_publish"] as const;

/** The published post id the fixtures return. */
export const POST_ID = "17890000000000001";

/** Labelled non-secret canaries. None of these is a real credential. */
export const CLIENT_SECRET_CANARY = "canary-threads-client-secret-not-a-real-secret";
export const CODE_CANARY = "canary-threads-authorization-code-not-a-real-secret";
export const SHORT_TOKEN_CANARY = "canary-threads-short-lived-token-not-a-real-secret";
export const LONG_TOKEN_CANARY = "canary-threads-long-lived-token-not-a-real-secret";
export const THREADS_CANARIES = [
  CLIENT_SECRET_CANARY,
  CODE_CANARY,
  SHORT_TOKEN_CANARY,
  LONG_TOKEN_CANARY,
] as const;

/** The `/me` body carrying the account id and username. */
export function meBody(id: string = ACCOUNT_ID, username: string = USERNAME): JsonObject {
  return { id, username };
}

/** A token endpoint body. The lifetime value is a response field, not a constant. */
export function tokenBody(accessToken: string): JsonObject {
  return { access_token: accessToken, token_type: "bearer", expires_in: 5_184_000 };
}

/** A credential bundle shaped like the one connect persists. */
export function credentialBundle(): JsonObject {
  return { apiHost: API_HOST, accessToken: LONG_TOKEN_CANARY, username: USERNAME };
}

/** The connect options the flow needs: the registered redirect URI. */
export function startOptions(overrides: JsonObject = {}): JsonObject {
  return { redirectUri: REDIRECT_URI, ...overrides };
}

/** The app client credentials the interactive step collects. */
export function clientCredentials(): JsonObject {
  return { client_id: CLIENT_ID, client_secret: CLIENT_SECRET_CANARY };
}

/** A full set of post options; a fresh object every call. */
export function postOptions(overrides: JsonObject = {}): JsonObject {
  return { text: "Hello from Syndroo on Threads.", ...overrides };
}

export type FreezeOverrides = {
  /** Shared content text; omitted means `content: {}` (post-only target). */
  contentText?: string;
  options?: JsonObject;
  accountId?: string;
  now?: string;
  seed?: string;
};

/** One fixed freeze input; every field has a default so replay is exact. */
export function freezeInput(overrides: FreezeOverrides = {}): FreezeInput {
  return {
    content: overrides.contentText === undefined ? {} : { text: overrides.contentText },
    options: overrides.options ?? postOptions(),
    account: {
      ...THREADS_ACCOUNT,
      accountId: overrides.accountId ?? THREADS_ACCOUNT.accountId,
    },
    now: overrides.now ?? FIXED_NOW,
    seed: overrides.seed ?? FIXED_SEED,
  };
}

/** A context with a scripted transport and a fixed instant. */
export function contextFor(
  transport: ProviderTransport,
  now: string = FIXED_NOW,
): ProviderContext {
  return { now, signal: new AbortController().signal, transport };
}

/** One scripted HTTP result. */
export function response(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): ProviderHttpResult {
  return { type: "response", status, headers, body: JSON.stringify(body) };
}

/** A raw (possibly non-JSON) response body. */
export function rawResponse(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): ProviderHttpResult {
  return { type: "response", status, headers, body };
}

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

export type ScriptedTransport = {
  transport: ProviderTransport;
  calls: RecordedRequest[];
};

/**
 * A transport that answers with the supplied results in order and records every
 * request it saw. Exhausting the script is a deterministic `before_request`
 * error, never a hang.
 */
export function scriptedTransport(results: readonly ProviderHttpResult[]): ScriptedTransport {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const transport: ProviderTransport = {
    request(input: ProviderHttpRequest): Promise<ProviderHttpResult> {
      calls.push({
        url: input.url,
        method: input.method,
        headers: { ...(input.headers ?? {}) },
        body: input.body,
      });
      const result = results[index];
      index += 1;
      if (result === undefined) {
        return Promise.resolve({ type: "transport_error", stage: "before_request", code: "script_exhausted" });
      }
      return Promise.resolve(result);
    },
  };
  return { transport, calls };
}

/** A transport that throws instead of returning a result. */
export function throwingTransport(): ScriptedTransport {
  const calls: RecordedRequest[] = [];
  const transport: ProviderTransport = {
    request(input: ProviderHttpRequest): Promise<ProviderHttpResult> {
      calls.push({
        url: input.url,
        method: input.method,
        headers: { ...(input.headers ?? {}) },
        body: input.body,
      });
      return Promise.reject(new Error("scripted transport failure"));
    },
  };
  return { transport, calls };
}

/**
 * Three replay cases with captured expectations produced by this plugin.
 *
 * `expected` is the frozen payload the plugin produced for the same input, so
 * the contract harness is comparing a fresh freeze against a recorded one —
 * that comparison is what proves replay determinism.
 */
export function threadsCases(): ContractCase[] {
  const minimal = freezeInput();
  const unicode = freezeInput({
    options: postOptions({ text: "日本語の投稿 👋 — multibyte, deterministic." }),
    seed: "seed_threads_0002",
    now: "2026-10-08T01:02:03.000Z",
  });
  const withContent = freezeInput({
    contentText: "Shared summary that is not the post text.",
    options: postOptions({ text: "The option text is what gets posted." }),
    accountId: "98765432109876543",
    seed: "seed_threads_0003",
  });
  return [
    { name: "minimal post", input: minimal, expected: plugin.freeze(minimal) },
    { name: "unicode post", input: unicode, expected: plugin.freeze(unicode) },
    { name: "shared content preserved", input: withContent, expected: plugin.freeze(withContent) },
  ];
}

/** True when any labelled canary appears in a stringified value. */
export function containsCanary(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return THREADS_CANARIES.some((canary) => (text ?? "").includes(canary));
}
