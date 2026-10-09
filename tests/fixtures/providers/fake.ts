/**
 * A deterministic fake Provider used by the SDK contract tests.
 *
 * This is test scaffolding, never shipped: it performs no I/O, reads no clock
 * and uses no randomness. Every derived value comes from the freeze input
 * (`now`, `seed`, content and options), so replaying the same input produces a
 * byte-identical payload.
 *
 * The credential canary below is a fixed string, not a secret. It exists so a
 * test can prove that neither a frozen payload nor a publish outcome echoes
 * credential material.
 */

import type {
  AccountIdentity,
  ContractCase,
  Content,
  FreezeInput,
  FrozenProviderPayload,
  Json,
  JsonObject,
  PreviewField,
  ProviderConnectInput,
  ProviderConnectResult,
  ProviderContext,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderPlugin,
  ProviderTransport,
  ProviderWriteOutcome,
  VerifiedIdentity,
} from "../../../packages/provider-sdk/src/index.js";
import { deepFreeze } from "../../../packages/provider-sdk/src/testing.js";

/** Version the fake manifest claims; contract tests pass the same string. */
export const FAKE_PROVIDER_VERSION = "1.0.0";
/** Fixed instant every fixture uses instead of a clock. */
export const FAKE_NOW = "2026-10-08T00:00:00.000Z";
/** Fixed submission seed, also used as the publish `submissionId`. */
export const FAKE_SEED = "seed_fake_0001";
/** Labelled non-secret canary for credential-leak checks. */
export const FAKE_SECRET_CANARY = "fake-fixture-canary-not-a-real-secret";
/** Account the fixture claims identity for. */
export const FAKE_ACCOUNT: AccountIdentity = {
  provider: "fake",
  accountId: "acct_fake_0001",
  origin: "https://fake.example",
};

const FAKE_DEFAULT_OPTIONS: JsonObject = {
  visibility: "public",
  tags: [],
  canonicalUrl: null,
};

/** Stable JSON with sorted keys, so a digest cannot depend on key order. */
function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`).join(",")}}`;
}

/** FNV-1a over canonical JSON. Deterministic, dependency-free, not a security hash. */
function digestOf(value: Json): string {
  const text = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a_${hash.toString(16).padStart(8, "0")}`;
}

function optionsWithDefaults(options: JsonObject): JsonObject {
  const effective: JsonObject = { ...FAKE_DEFAULT_OPTIONS };
  for (const key of Object.keys(options)) {
    effective[key] = options[key] as Json;
  }
  return effective;
}

function field(name: string, value: Json): PreviewField {
  return { name, value };
}

/**
 * Expand defaults and build a complete preview.
 *
 * Every effective option becomes a preview field, and the effective content is
 * repeated verbatim in `preview.content`, so a reader sees the whole payload
 * with no ellipsis and no hidden option.
 */
function freezeFake(input: FreezeInput): FrozenProviderPayload {
  const effectiveOptions = optionsWithDefaults(input.options);
  const effectiveContent: Content = { text: input.content.text ?? "" };

  const fields: PreviewField[] = [
    field("text", effectiveContent.text ?? ""),
    ...Object.keys(effectiveOptions)
      .sort()
      .map((key) => field(key, effectiveOptions[key] as Json)),
  ];

  const digest = digestOf({
    account: input.account.accountId,
    now: input.now,
    seed: input.seed,
    content: effectiveContent.text ?? "",
    options: effectiveOptions,
  });

  const payload: JsonObject = {
    provider: "fake",
    accountId: input.account.accountId,
    text: effectiveContent.text ?? "",
    digest,
  };

  return deepFreeze({
    payloadVersion: 1,
    payload,
    effectiveContent: { ...effectiveContent },
    effectiveOptions: { ...effectiveOptions },
    preview: { content: { ...effectiveContent }, fields },
  });
}

/** Deterministic mapping from one transport result to a write outcome. */
function outcomeFor(result: ProviderHttpResult, submissionId: string): ProviderWriteOutcome {
  if (result.type === "transport_error") {
    if (result.stage === "before_request") {
      return { status: "failed", disposition: "not_applied", retryable: true, reason: "network" };
    }
    // The request may have been sent: an ambiguous outcome stays unknown.
    return { status: "unknown", disposition: "unknown", reason: "network" };
  }
  if (result.status === 200) {
    return { status: "succeeded", remoteId: `fake_${submissionId}`, url: `https://fake.example/fake_${submissionId}` };
  }
  if (result.status === 429) {
    return { status: "failed", disposition: "not_applied", retryable: true, reason: "rate_limited" };
  }
  if (result.status === 401) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" };
  }
  if (result.status === 403) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "permission" };
  }
  if (result.status === 400 || result.status === 422) {
    return { status: "failed", disposition: "not_applied", retryable: false, reason: "validation" };
  }
  // A 5xx answer to a write does not prove the write was rejected.
  return {
    status: "unknown",
    disposition: "unknown",
    reason: result.status >= 500 ? "provider_unavailable" : "unknown",
  };
}

export type FakeProviderOptions = {
  version?: string;
  declaredCapabilities?: readonly ("text" | "article")[];
  freeze?: (input: FreezeInput) => FrozenProviderPayload;
  publish?: (input: Parameters<ProviderPlugin["publish"]>[0]) => Promise<ProviderWriteOutcome>;
};

/** Build the deterministic fake plugin. */
export function createFakeProvider(options: FakeProviderOptions = {}): ProviderPlugin {
  const connect = {
    async run(input: ProviderConnectInput, context: ProviderContext): Promise<ProviderConnectResult> {
      if (input.type === "start") {
        return {
          status: "action_required",
          action: {
            type: "credential_input",
            fields: [{ name: "canary", label: "Fake test credential", secret: true }],
          },
          privateState: { startedAt: context.now },
        };
      }
      return {
        status: "done",
        credentials: { canary: FAKE_SECRET_CANARY },
        identity: {
          account: FAKE_ACCOUNT,
          evidence: [{ capability: "identity", value: "supported", source: "fake.example", verifiedAt: context.now }],
        },
      };
    },
    async verify(_credentials: JsonObject, context: ProviderContext): Promise<VerifiedIdentity> {
      return {
        account: FAKE_ACCOUNT,
        evidence: [
          { capability: "identity", value: "supported", source: "fake.example", verifiedAt: context.now },
          { capability: "text", value: "supported", source: "fake.example", verifiedAt: context.now },
        ],
      };
    },
  };

  return {
    manifest: {
      id: "fake",
      name: "Fake Provider",
      version: options.version ?? FAKE_PROVIDER_VERSION,
      apiVersion: 1,
      declaredCapabilities: options.declaredCapabilities ?? ["text"],
      // The fixture never performs a real request; the declaration exists so a
      // host can build a policy for it exactly as for an official provider.
      egress: { fixedOrigins: ["https://social.example"] },
      schemas: {
        connectOptions: { type: "object", additionalProperties: false },
        credentialInput: { type: "object", required: ["canary"] },
        content: { type: "object", properties: { text: { type: "string" } } },
        publishOptions: { type: "object", properties: { visibility: { type: "string" } } },
      },
    },
    connect,
    freeze: options.freeze ?? freezeFake,
    async publish(input) {
      if (options.publish !== undefined) {
        return options.publish(input);
      }
      const result = await input.context.transport.request({
        url: "https://fake.example/v1/publish",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: input.submissionId, digest: input.frozen.payload.digest }),
        signal: input.context.signal,
      });
      return outcomeFor(result, input.submissionId);
    },
  };
}

/** A transport that answers every request with the supplied fixed result. */
export function createFakeTransport(result: ProviderHttpResult): ProviderTransport {
  return {
    request(_input: ProviderHttpRequest): Promise<ProviderHttpResult> {
      return Promise.resolve(result);
    },
  };
}

export type FreezeInputOverrides = {
  text?: string;
  options?: JsonObject;
  account?: AccountIdentity;
  now?: string;
  seed?: string;
};

/** One fixed freeze input. Every field has a default so replay is exact. */
export function fakeFreezeInput(overrides: FreezeInputOverrides = {}): FreezeInput {
  return {
    content: { text: overrides.text ?? "Fake provider fixture text." },
    options: overrides.options ?? {},
    account: overrides.account ?? FAKE_ACCOUNT,
    now: overrides.now ?? FAKE_NOW,
    seed: overrides.seed ?? FAKE_SEED,
  };
}

/**
 * Two replay cases: plain text and an article-shaped option set.
 *
 * `expected` is a captured snapshot from this plugin, not a hand-typed second
 * source of truth. The harness compares a later freeze against that snapshot,
 * which is what proves replay determinism; `test/contract.test.ts` also
 * compares two independently built plugin instances.
 */
export function createFakeCases(): ContractCase[] {
  const plugin = createFakeProvider();
  const textInput = fakeFreezeInput();
  const articleInput = fakeFreezeInput({
    text: "Fake article summary.",
    seed: "seed_fake_0002",
    account: { provider: "fake", accountId: "acct_fake_0002", origin: "https://fake.example" },
    options: {
      visibility: "unlisted",
      title: "A fixture article",
      body: "The full article body, preserved verbatim by the fixture.",
      tags: ["fixtures", "contract"],
      canonicalUrl: "https://example.test/fixture-article",
    },
  });
  return [
    { name: "plain text", input: textInput, expected: plugin.freeze(textInput) },
    { name: "article options", input: articleInput, expected: plugin.freeze(articleInput) },
  ];
}
