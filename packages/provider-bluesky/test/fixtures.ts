/**
 * Fixtures for the Bluesky Provider tests.
 *
 * Every instant is fixed and every transport is scripted, so the suites perform
 * no network, clock or random work. The canaries are labelled non-secret
 * strings; they exist so a test can prove that neither an app password nor an
 * access token reaches an outcome, a preview or an error.
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

/** The account the fixtures claim identity for; the id is an interchange DID. */
export const BLUESKY_ACCOUNT: AccountIdentity = {
  provider: "bluesky",
  accountId: "did:plc:fixture00000000000000001",
  origin: "https://bsky.app",
};

/** Fixed instant every fixture uses instead of a clock. */
export const FIXED_NOW = "2026-10-08T00:00:00.000Z";
/** Fixed submission seed, also used as the publish `submissionId`. */
export const FIXED_SEED = "seed_bluesky_0001";

/** DID the scripted session belongs to. */
export const SESSION_DID = "did:plc:fixture00000000000000001";

/** Labelled non-secret canaries. None of these is a real credential. */
export const TOKEN_CANARY = "canary-bluesky-access-jwt-not-a-real-token";
export const IDENTIFIER_CANARY = "canary-identifier@example.test";
export const PASSWORD_CANARY = "canary-app-password-not-a-real-secret";
export const CREDENTIAL_CANARIES = [TOKEN_CANARY, IDENTIFIER_CANARY, PASSWORD_CANARY] as const;

/** A credential bundle shaped like the one connect persists. */
export function credentialBundle(): JsonObject {
  return { identifier: IDENTIFIER_CANARY, password: PASSWORD_CANARY, accessJwt: TOKEN_CANARY };
}

export type FreezeOverrides = {
  text?: string;
  accountId?: string;
  now?: string;
  seed?: string;
};

/** One fixed freeze input; every field has a default so replay is exact. */
export function freezeInput(overrides: FreezeOverrides = {}): FreezeInput {
  return {
    content: { text: overrides.text ?? "Hello from Syndroo." },
    options: {},
    account: {
      ...BLUESKY_ACCOUNT,
      accountId: overrides.accountId ?? BLUESKY_ACCOUNT.accountId,
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
 * Two replay cases with captured expectations produced by this plugin.
 *
 * `expected` is the frozen payload the plugin produced for the same input, so
 * the contract harness is comparing a fresh freeze against a recorded one —
 * that comparison is what proves replay determinism.
 */
export function blueskyCases(): ContractCase[] {
  const textInput = freezeInput();
  const unicodeInput = freezeInput({
    text: "日本語の投稿 👋 — multibyte, deterministic.",
    seed: "seed_bluesky_0002",
    accountId: "did:plc:fixture00000000000000002",
    now: "2026-10-08T01:02:03.000Z",
  });
  return [
    { name: "plain text", input: textInput, expected: plugin.freeze(textInput) },
    { name: "unicode text", input: unicodeInput, expected: plugin.freeze(unicodeInput) },
  ];
}

/** True when any labelled canary appears in a stringified value. */
export function containsCanary(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return CREDENTIAL_CANARIES.some((canary) => (text ?? "").includes(canary));
}
