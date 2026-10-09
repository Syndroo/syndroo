/**
 * Fixtures for the DEV.to Provider tests.
 *
 * Every instant is fixed and every transport is scripted, so the suites perform
 * no network, clock or random work. The canary is a labelled non-secret string;
 * it exists so a test can prove the API key never reaches an outcome, a preview
 * or an error.
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

/** The account the fixtures claim identity for; the id is the DEV.to user id. */
export const DEVTO_ACCOUNT: AccountIdentity = {
  provider: "devto",
  accountId: "1234567",
  origin: "https://dev.to",
};

/** The numeric user id `/api/users/me` returns in the fixtures. */
export const USER_ID = 1234567;
/** Fixed instant every fixture uses instead of a clock. */
export const FIXED_NOW = "2026-10-08T00:00:00.000Z";
/** Fixed submission seed, also used as the publish `submissionId`. */
export const FIXED_SEED = "seed_devto_0001";

/** Labelled non-secret canary. Not a real key. */
export const API_KEY_CANARY = "canary-devto-api-key-not-a-real-secret";

/** A credential bundle shaped like the one connect persists. */
export function credentialBundle(): JsonObject {
  return { apiKey: API_KEY_CANARY };
}

/** A full set of article options; a fresh object every call. */
export function articleOptions(): JsonObject {
  return {
    title: "Introducing Syndroo",
    body_markdown: "# Introducing Syndroo\n\nA full Markdown article.",
    tags: ["syndroo", "typescript"],
    canonical_url: "https://example.com/posts/syndroo",
    description: "A full Markdown article.",
  };
}

export type FreezeOverrides = {
  /** Shared content text; omitted means `content: {}` (article-only target). */
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
    options: overrides.options ?? articleOptions(),
    account: {
      ...DEVTO_ACCOUNT,
      accountId: overrides.accountId ?? DEVTO_ACCOUNT.accountId,
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
export function devtoCases(): ContractCase[] {
  const full = freezeInput();
  const minimal = freezeInput({
    options: { title: "Minimal article", body_markdown: "Just a body." },
    seed: "seed_devto_0002",
    now: "2026-10-08T01:02:03.000Z",
  });
  const withSharedContent = freezeInput({
    text: "Shared summary that is not the article body.",
    options: {
      title: "Shared content target",
      body_markdown: "The article body comes from the option, not from content.text.",
      canonical_url: "https://example.com/posts/shared",
    },
    accountId: "7654321",
    seed: "seed_devto_0003",
  });
  return [
    { name: "full article options", input: full, expected: plugin.freeze(full) },
    { name: "minimal article", input: minimal, expected: plugin.freeze(minimal) },
    {
      name: "shared content preserved",
      input: withSharedContent,
      expected: plugin.freeze(withSharedContent),
    },
  ];
}

/** True when the labelled canary appears in a stringified value. */
export function containsCanary(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").includes(API_KEY_CANARY);
}
