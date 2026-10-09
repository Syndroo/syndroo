/**
 * Fixtures for the LinkedIn Provider tests.
 *
 * Every instant is fixed and every transport is scripted, so the suites perform
 * no network, clock or random work. The canaries are labelled non-secret
 * strings; they exist so a test can prove that the client secret, the
 * authorization code and the access token never reach a preview, an outcome or
 * an error.
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

/** The member id `/v2/me` returns in the fixtures; it is the posting author. */
export const MEMBER_ID = "AbCdEfGhIj";

/** The account the fixtures claim identity for; origin is the member site. */
export const LINKEDIN_ACCOUNT: AccountIdentity = {
  provider: "linkedin",
  accountId: MEMBER_ID,
  origin: "https://www.linkedin.com",
};

/** Fixed instant every fixture uses instead of a clock. */
export const FIXED_NOW = "2026-10-08T00:00:00.000Z";
/** Fixed submission seed, also used as the publish `submissionId`. */
export const FIXED_SEED = "seed_linkedin_0001";

/** The app client id the fixtures register. */
export const CLIENT_ID = "linkedin-client-id-fixture";
/** The fixed callback the fixtures register and reuse. */
export const REDIRECT_URI = "http://127.0.0.1:7777/oauth/callback";
/** The scopes the flow asks for by default. */
export const SCOPES = ["w_member_social", "openid", "profile"] as const;
/** The one visibility the fixtures exercise; it is a pass-through string. */
export const DEFAULT_VISIBILITY = "PUBLIC";

/** Labelled non-secret canaries. None of these is a real credential. */
export const CLIENT_SECRET_CANARY = "canary-linkedin-client-secret-not-a-real-secret";
export const CODE_CANARY = "canary-linkedin-authorization-code-not-a-real-secret";
export const TOKEN_CANARY = "canary-linkedin-access-token-not-a-real-secret";
export const CALLBACK_CANARIES = [CLIENT_SECRET_CANARY, CODE_CANARY, TOKEN_CANARY] as const;

/** The `/v2/me` body carrying the member id; `sub` is present but never used. */
export function memberBody(id: string = MEMBER_ID): JsonObject {
  return { id, localizedFirstName: "Some", localizedLastName: "One" };
}

/** A `/v2/me` body that carries only `sub`, the app-scoped OIDC subject. */
export function subOnlyBody(): JsonObject {
  return { sub: "app-scoped-oidc-subject-not-a-member-id", name: "Someone" };
}

/** The token endpoint body. */
export function tokenBody(): JsonObject {
  return { access_token: TOKEN_CANARY, expires_in: 5_184_000 };
}

/** A credential bundle shaped like the one connect persists. */
export function credentialBundle(): JsonObject {
  return { accessToken: TOKEN_CANARY };
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
  return {
    commentary: "Hello from Syndroo on LinkedIn.",
    visibility: DEFAULT_VISIBILITY,
    ...overrides,
  };
}

export type FreezeOverrides = {
  /** Shared content text; omitted means `content: {}` (post-only target). */
  text?: string;
  options?: JsonObject;
  accountId?: string;
  now?: string;
  seed?: string;
};

/** One fixed freeze input; every field has a default so replay is exact. */
export function freezeInput(overrides: FreezeOverrides = {}): FreezeInput {
  return {
    content: overrides.text === undefined ? {} : { text: overrides.text },
    options: overrides.options ?? postOptions(),
    account: {
      ...LINKEDIN_ACCOUNT,
      accountId: overrides.accountId ?? LINKEDIN_ACCOUNT.accountId,
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
export function linkedinCases(): ContractCase[] {
  const minimal = freezeInput();
  const withAuthor = freezeInput({
    options: postOptions({ author: "member", commentary: "An explicit member author." }),
    seed: "seed_linkedin_0002",
    now: "2026-10-08T01:02:03.000Z",
  });
  const withContent = freezeInput({
    text: "Shared summary that is not the commentary.",
    options: postOptions({
      commentary: "日本語の投稿 👋 — multibyte, deterministic.",
      visibility: "CONNECTIONS",
    }),
    accountId: "ZzYyXxWwVv",
    seed: "seed_linkedin_0003",
  });
  return [
    { name: "minimal post", input: minimal, expected: plugin.freeze(minimal) },
    { name: "explicit member author", input: withAuthor, expected: plugin.freeze(withAuthor) },
    { name: "shared content preserved", input: withContent, expected: plugin.freeze(withContent) },
  ];
}

/** True when any labelled canary appears in a stringified value. */
export function containsCanary(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return CALLBACK_CANARIES.some((canary) => (text ?? "").includes(canary));
}
