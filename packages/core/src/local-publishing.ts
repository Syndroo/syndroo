/**
 * Contracts shared by the local CLI publishing path and the Bluesky/Threads
 * adapters.
 *
 * This module stays platform-neutral on purpose: no Node imports, no CLI
 * imports, no Cloudflare or runtime-specific types. Provider wire payloads stay
 * inside the adapters; only the frozen shapes below are shared.
 */

/** Platforms with a local (no server) publishing path in this version. */
export type LocalProviderId = "bluesky" | "threads";

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

/** The exact content and non-secret payload approved in a plan. */
export interface FrozenDelivery {
  readonly deliveryId: string;
  readonly key: string;
  readonly namespace: string;
  readonly target: TargetBinding;
  readonly content: string;
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

/** Credential material for one local provider, resolved in memory only. */
export type LocalCredentials =
  | {
      readonly provider: "bluesky";
      readonly identifier: string;
      readonly password: string;
      readonly host: string;
    }
  | { readonly provider: "threads"; readonly accessToken: string };

/** What the CLI reports for a local provider. */
export interface LocalProviderDescription {
  readonly provider: LocalProviderId;
  readonly maturity: "fixture-tested";
  readonly localPublish: true;
  readonly unavailableReason: null;
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
  ): { payloadVersion: number; payload: Readonly<Record<string, unknown>> };
  verifyIdentity(
    credentials: LocalCredentials,
    signal: AbortSignal,
  ): Promise<{ targetId: string }>;
  prepare(
    credentials: LocalCredentials,
    target: TargetBinding,
    signal: AbortSignal,
  ): Promise<PreparedTarget>;
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
