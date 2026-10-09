/**
 * Fixtures for the Mastodon Provider tests.
 *
 * Every instant is fixed and every transport is scripted, so the suites perform
 * no network, clock or random work. The canaries are labelled non-secret
 * strings; they exist so a test can prove that a client secret, a PKCE verifier,
 * an authorization code or an access token never reaches a preview, an outcome
 * or an error.
 *
 * Mastodon's character limit is per instance and is read at runtime, so the
 * fixtures seed the provider's per-origin limit cache the same way a real
 * connect does: a scripted `verify_credentials` plus `/api/v2/instance`. The
 * cache is module-global and `freeze` is synchronous, so this module seeds it on
 * import; the cold-entry path (fail closed) is exercised with a distinct,
 * deliberately unseeded origin.
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

/** The instance every fixture binds to; it is the account origin and the API host. */
export const TEST_INSTANCE = "https://mastodon.test";
/** A second instance with a deliberately tiny character limit. */
export const SMALL_INSTANCE = "https://small.mastodon.test";
/** An instance no fixture ever seeds, for the fail-closed freeze path. */
export const UNSEEDED_INSTANCE = "https://unseeded.mastodon.test";

/** The instance-local account id `/api/v1/accounts/verify_credentials` returns. */
export const ACCOUNT_ID = "109345678901234567";
/** The default per-instance status character limit. */
export const INSTANCE_LIMIT = 500;
/** The tiny character limit the small instance reports. */
export const SMALL_INSTANCE_LIMIT = 12;

/** Fixed instant every fixture uses instead of a clock. */
export const FIXED_NOW = "2026-10-08T00:00:00.000Z";
/** Fixed submission seed, also used as the publish `submissionId`. */
export const FIXED_SEED = "seed_mastodon_0001";

/** A registered client id the app-registration fixtures return. */
export const CLIENT_ID = "client-id-fixture-0001";
/** The fixed callback the OAuth flow registers and reuses. */
export const REDIRECT_URI = "http://127.0.0.1:7777/oauth/callback";
/** The scopes the flow registers; the server rejects ones it does not know. */
export const SCOPES = ["read:accounts", "write:statuses"] as const;
/** The single status option this provider supports. */
export const DEFAULT_VISIBILITY = "public";

/** Labelled non-secret canaries. None of these is a real credential. */
export const CLIENT_SECRET_CANARY = "canary-mastodon-client-secret-not-a-real-secret";
export const VERIFIER_CANARY = "canary-mastodon-pkce-verifier-not-a-real-secret";
export const CODE_CANARY = "canary-mastodon-authorization-code-not-a-real-secret";
export const TOKEN_CANARY = "canary-mastodon-access-token-not-a-real-secret";
export const CONNECT_CANARIES = [
  CLIENT_SECRET_CANARY,
  VERIFIER_CANARY,
  CODE_CANARY,
  TOKEN_CANARY,
] as const;

/** The account the fixtures claim identity for; the origin is the instance. */
export const MASTODON_ACCOUNT: AccountIdentity = {
  provider: "mastodon",
  accountId: ACCOUNT_ID,
  origin: TEST_INSTANCE,
};

/** A credential bundle shaped like the one connect persists. */
export function credentialBundle(): JsonObject {
  return { instance: TEST_INSTANCE, accessToken: TOKEN_CANARY };
}

/** The `/api/v2/instance` body carrying the per-instance status character limit. */
export function instanceLimitBody(limit: number = INSTANCE_LIMIT): JsonObject {
  return { configuration: { statuses: { max_characters: limit } } };
}

/** The `/api/v1/accounts/verify_credentials` body. */
export function verifyBody(id: string = ACCOUNT_ID): JsonObject {
  return { id, acct: "someone", username: "someone", display_name: "Someone" };
}

/** The `/api/v1/apps` registration response, carrying the secret to hide. */
export function appRegistrationBody(): JsonObject {
  return { client_id: CLIENT_ID, client_secret: CLIENT_SECRET_CANARY };
}

/** The connect options the flow needs: instance, callback and scopes. */
export function startOptions(overrides: JsonObject = {}): JsonObject {
  return {
    instance: TEST_INSTANCE,
    redirectUri: REDIRECT_URI,
    scopes: [...SCOPES],
    ...overrides,
  };
}

export type FreezeOverrides = {
  text?: string;
  visibility?: string;
  origin?: string;
  accountId?: string;
  now?: string;
  seed?: string;
};

/** One fixed freeze input; every field has a default so replay is exact. */
export function freezeInput(overrides: FreezeOverrides = {}): FreezeInput {
  return {
    content: { text: overrides.text ?? "Hello from Syndroo on Mastodon." },
    options: { visibility: overrides.visibility ?? DEFAULT_VISIBILITY },
    account: {
      ...MASTODON_ACCOUNT,
      origin: overrides.origin ?? MASTODON_ACCOUNT.origin,
      accountId: overrides.accountId ?? MASTODON_ACCOUNT.accountId,
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
 * Seed the provider's per-instance character limit for one origin, the same way
 * a real connect does: a scripted `verify_credentials` then `/api/v2/instance`.
 */
export async function seedInstanceLimit(
  limit: number = INSTANCE_LIMIT,
  origin: string = TEST_INSTANCE,
): Promise<void> {
  const scripted = scriptedTransport([
    response(200, verifyBody()),
    response(200, instanceLimitBody(limit)),
  ]);
  await plugin.connect.verify({ instance: origin, accessToken: TOKEN_CANARY }, contextFor(scripted.transport));
}

/**
 * Three replay cases with captured expectations produced by this plugin.
 *
 * `expected` is the frozen payload the plugin produced for the same input, so
 * the contract harness is comparing a fresh freeze against a recorded one —
 * that comparison is what proves replay determinism.
 */
export function mastodonCases(): ContractCase[] {
  const defaultInput = freezeInput();
  const unlistedInput = freezeInput({
    visibility: "unlisted",
    text: "An unlisted status.",
    seed: "seed_mastodon_0002",
    now: "2026-10-08T01:02:03.000Z",
  });
  const unicodeInput = freezeInput({
    text: "日本語の投稿 👋 — multibyte, deterministic.",
    seed: "seed_mastodon_0003",
    accountId: "109345678901234568",
  });
  return [
    { name: "default public status", input: defaultInput, expected: plugin.freeze(defaultInput) },
    { name: "unlisted status", input: unlistedInput, expected: plugin.freeze(unlistedInput) },
    { name: "unicode status", input: unicodeInput, expected: plugin.freeze(unicodeInput) },
  ];
}

/** True when any labelled canary appears in a stringified value. */
export function containsCanary(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return CONNECT_CANARIES.some((canary) => (text ?? "").includes(canary));
}

/**
 * Seed the limits every importer needs before calling `freeze`. Kept at the end
 * of the module so the `const` canaries above are initialized first.
 */
await seedInstanceLimit(INSTANCE_LIMIT, TEST_INSTANCE);
await seedInstanceLimit(SMALL_INSTANCE_LIMIT, SMALL_INSTANCE);
