/**
 * Contracts shared by the local CLI publishing path and the Bluesky/Threads
 * adapters.
 *
 * This module stays platform-neutral on purpose: no Node imports, no CLI
 * imports, no Cloudflare or runtime-specific types. Provider wire payloads stay
 * inside the adapters; only the frozen shapes below are shared.
 */

/** Platforms with a local (no server) publishing path in this version. */
export type LocalProviderId =
  | "bluesky"
  | "threads"
  | "linkedin"
  | "mastodon"
  | "devto";

/** Providers whose records predate the schema-2 article/observation fields. */
export type LegacyLocalProviderId = "bluesky" | "threads" | "linkedin";

export const LEGACY_LOCAL_PROVIDER_IDS: readonly LegacyLocalProviderId[] = [
  "bluesky",
  "threads",
  "linkedin",
];

/** True for a provider a schema-1 record is still allowed to name. */
export function isLegacyLocalProvider(
  value: unknown,
): value is LegacyLocalProviderId {
  return (
    typeof value === "string" &&
    (LEGACY_LOCAL_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** Per-target state of one logical delivery. */
export type TargetStatus =
  | "not_started"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "unknown";

/** Stable local identity of one publishing account. */
export interface TargetBinding {
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
}

/**
 * Article metadata one provider's frozen payload was built from.
 *
 * The order of `tags` is part of the approved input and is never reordered.
 */
export interface LocalArticleOptions {
  readonly title: string;
  readonly tags?: readonly string[];
  readonly canonicalUrl?: string;
}

/** Content options a document carries for one provider. */
export interface LocalContentOptions {
  readonly article?: LocalArticleOptions;
}

/** The exact content and non-secret payload approved in a plan. */
export interface FrozenDelivery {
  readonly deliveryId: string;
  readonly key: string;
  readonly namespace: string;
  readonly target: TargetBinding;
  readonly content: string;
  /**
   * Present only when the approved input carried metadata; legacy deliveries
   * never materialize an `undefined` here, so their signed bytes are unchanged.
   */
  readonly contentOptions?: LocalContentOptions;
  readonly payloadVersion: number;
  readonly payloadHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * What a provider reported for one attempt.
 *
 * `unknown` is the honest answer for a timeout, a lost connection, or a 2xx
 * without a usable id: the write may have reached the platform.
 */
export type ProviderOutcome =
  | { kind: "succeeded"; remoteId: string; url: string | null }
  | {
      kind: "failed";
      code: string;
      writeDisposition: "not_applied";
      retryable: boolean;
      retryNotBefore: string | null;
    }
  | { kind: "unknown"; code: string; writeDisposition: "unknown" };

/**
 * An authenticated target held in memory for the duration of one execution.
 * Never serialized; an auth session is not a record.
 */
export interface PreparedTarget {
  readonly target: TargetBinding;
  publish(
    delivery: FrozenDelivery,
    signal: AbortSignal,
  ): Promise<ProviderOutcome>;
}

/** Instance limits one Mastodon-compatible server reports about itself. */
export interface LocalInstanceCapabilities {
  readonly maxCharacters: number;
  readonly charactersReservedPerUrl: number;
}

/**
 * Non-secret observation of one local account, cached with its binding.
 *
 * It never carries a token, a source path, or a credential fingerprint.
 */
export interface LocalInstanceObservation {
  readonly displayName: string | null;
  readonly lastVerifiedAt: string;
  readonly scopes: readonly string[] | null;
  readonly capabilities: LocalInstanceCapabilities | null;
  readonly capabilitySource: string | null;
  readonly capabilityCheckedAt: string | null;
  readonly writePermission: "unknown";
}

/** Credential material for one local provider, resolved in memory only. */
export type LocalCredentials =
  | {
      readonly provider: "bluesky";
      readonly identifier: string;
      readonly password: string;
      readonly host: string;
    }
  | { readonly provider: "threads"; readonly accessToken: string }
  | { readonly provider: "linkedin"; readonly accessToken: string; readonly author: string; readonly apiVersion: string }
  | {
      readonly provider: "mastodon";
      readonly instance: string;
      readonly accessToken: string;
    }
  | { readonly provider: "devto"; readonly apiKey: string };

/** Provider-confirmed identity. Display names never replace stable IDs. */
export interface LocalIdentity {
  readonly targetId: string;
  readonly displayName?: string;
  /** Instance limits, when the provider can read them during identity lookup. */
  readonly capabilities?: LocalInstanceCapabilities;
  /** Granted scopes, when the platform reports them. Never a token. */
  readonly scopes?: readonly string[];
}

/** Only bounded display text that cannot control a terminal. */
export function localDisplayName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 &&
    [...value].length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value : undefined;
}

/** Static capability names a description may carry. */
export type LocalContentType = "text" | "article";
export type LocalAuthMethod =
  | "app-password"
  | "user-token"
  | "oauth"
  | "api-key";

/** What the CLI reports for a local provider. */
export interface LocalProviderDescription {
  readonly provider: LocalProviderId;
  readonly maturity: "fixture-tested";
  readonly localPublish: true;
  readonly unavailableReason: null;
  /** Static metadata names; new providers populate all of them. */
  readonly contentTypes?: readonly LocalContentType[];
  readonly authMethods?: readonly LocalAuthMethod[];
  readonly media?: false;
  readonly scheduling?: false;
}

/**
 * One local provider.
 *
 * Constructors are zero-network: identity lookups and auth sessions only
 * happen inside `verifyIdentity` and `prepare`. `prepare` must return a target
 * that matches the frozen binding.
 */
export interface LocalProvider {
  readonly provider: LocalProviderId;
  describe(): LocalProviderDescription;
  freeze(
    content: string,
    createdAt: string,
    options?: LocalContentOptions,
  ): { payloadVersion: number; payload: Readonly<Record<string, unknown>> };
  verifyIdentity(
    credentials: LocalCredentials,
    signal: AbortSignal,
  ): Promise<LocalIdentity>;
  prepare(
    credentials: LocalCredentials,
    target: TargetBinding,
    signal: AbortSignal,
    delivery?: FrozenDelivery,
  ): Promise<PreparedTarget>;
  /**
   * Optional adapter-owned validation of frozen text against a cached
   * capability snapshot.
   *
   * The platform's own length algorithm belongs to its adapter package: this
   * hook lets the plan-time and preview-time gates use the cached limits without
   * core guessing a URL or grapheme algorithm. An adapter that publishes text
   * with instance limits must implement it; a provider without limits omits it.
   */
  validateCachedContent?(
    content: string,
    capabilities: LocalInstanceCapabilities,
  ): void;
}

/** Preparation failures a local provider may report. */
export type LocalProviderErrorCode =
  | "AUTH"
  | "ACCOUNT_MISMATCH"
  | "INVALID_CONTENT"
  | "PROVIDER_UNAVAILABLE"
  | "ABORTED";

const LOCAL_PROVIDER_ERROR_MESSAGE: Readonly<
  Record<LocalProviderErrorCode, string>
> = {
  AUTH: "the provider rejected the credentials",
  ACCOUNT_MISMATCH: "the credentials identify a different account",
  INVALID_CONTENT: "the provider rejected the frozen content",
  PROVIDER_UNAVAILABLE: "the provider is unavailable",
  ABORTED: "the provider call was aborted",
};

/**
 * Typed preparation failure.
 *
 * Only the code is accepted: a provider must not attach a raw error, response
 * body, or credential to a message that the CLI later prints.
 */
export class LocalProviderError extends Error {
  readonly code: LocalProviderErrorCode;

  constructor(code: LocalProviderErrorCode) {
    super(LOCAL_PROVIDER_ERROR_MESSAGE[code]);
    this.name = "LocalProviderError";
    this.code = code;
  }
}
