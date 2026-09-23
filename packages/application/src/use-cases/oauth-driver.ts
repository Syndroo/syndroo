/**
 * Portable OAuth driver contract.
 *
 * A driver is an immutable snapshot for one operation: it carries the platform,
 * the protocol, the canonical callback URL and the configuration fingerprint,
 * and it owns protocol details, fixed provider endpoints, response decoding and
 * platform-specific target validation. Concrete drivers live in the runtime
 * composition; this module imports neither Worker nor provider packages and
 * contains no transport, no DI container and no framework.
 *
 * The application owns every state transition, encryption context and revision
 * guard around these four operations. `confirm` is synchronous by contract and
 * must not perform network work; `refresh` is present only for protocols that
 * support it.
 */

import type { Platform } from "@syndroo/core";

import type { IsoInstant } from "../contracts/primitives.js";
import type { SafeTarget } from "../contracts/status.js";

export type OAuthProtocol = "oauth1" | "oauth2";

/**
 * Immutable identity of one resolved driver.
 *
 * `startConfigBinding` is the domain-separated fingerprint of the configuration
 * the operation started from. The resolver derives it from copied instance
 * configuration only — never from request headers — and includes app secrets in
 * the signed material without storing or exposing them.
 */
export interface OAuthDriverSnapshot {
  readonly platform: Platform;
  readonly protocol: OAuthProtocol;
  readonly canonicalCallbackUrl: string;
  readonly startConfigBinding: string;
}

/** Bounded, already validated callback values. */
export interface OAuthCallbackSnapshot {
  readonly platform: Platform;
  readonly state: string;
  readonly code: string | null;
  readonly verifier: string | null;
  readonly requestToken: string | null;
}

export interface OAuthBeginInput {
  readonly state: string;
  readonly now: IsoInstant;
}

export interface OAuthBeginResult {
  /** Provider authorization URL; protocol-required parameters live only here. */
  readonly authorizationUrl: string;
  /** OAuth1 request token, or null for a protocol that has none. */
  readonly requestToken: string | null;
  /** OAuth1 request-token secret bytes; copied before the first await. */
  readonly requestSecret: Uint8Array | null;
}

export interface OAuthExchangeInput {
  readonly callback: OAuthCallbackSnapshot;
  /** Decrypted original request secret, or null when the protocol has none. */
  readonly requestSecret: Uint8Array | null;
  readonly now: IsoInstant;
}

/** Result of one provider exchange. Buffers are copied by the application. */
export interface OAuthExchangeResult {
  /** Native credential plaintext for the platform's active slot schema. */
  readonly plaintext: Uint8Array;
  readonly expiresAt: IsoInstant | null;
  /** Validated provider-confirmed target, or null when none is known. */
  readonly target: SafeTarget | null;
  /** Fixed allowlisted configuration names the operator must still supply. */
  readonly missingFields: readonly string[];
}

/** Explicit target confirmation values; never inherited from active state. */
export interface OAuthTargetOverrides {
  readonly author: string | null;
  readonly apiVersion: string | null;
  readonly blog: string | null;
}

export interface OAuthConfirmInput {
  readonly candidate: Uint8Array;
  readonly target: OAuthTargetOverrides;
  readonly now: IsoInstant;
}

export interface OAuthConfirmResult {
  readonly plaintext: Uint8Array;
  readonly target: SafeTarget | null;
  readonly missingFields: readonly string[];
}

export interface OAuthRefreshInput {
  readonly plaintext: Uint8Array;
  readonly now: IsoInstant;
}

export interface OAuthRefreshResult {
  readonly plaintext: Uint8Array;
  readonly expiresAt: IsoInstant | null;
}

export interface OAuthDriver extends OAuthDriverSnapshot {
  /** Exactly one request-token acquisition for OAuth1; no request for OAuth2. */
  begin(input: OAuthBeginInput): Promise<OAuthBeginResult>;
  /** One exchange attempt; no automatic retry is performed by the caller. */
  exchange(input: OAuthExchangeInput): Promise<OAuthExchangeResult>;
  /** Synchronous, network-free confirmation of the candidate and its target. */
  confirm(input: OAuthConfirmInput): OAuthConfirmResult;
  /** Absent when the resolved platform does not support refresh in this release. */
  readonly refresh?: (input: OAuthRefreshInput) => Promise<OAuthRefreshResult>;
}

/**
 * Resolve the immutable driver snapshot for one platform, or null.
 *
 * Async is part of the contract, not a cast: a real configuration fingerprint
 * uses WebCrypto HMAC, so the runtime resolver returns a promise.
 */
export type OAuthDriverResolver = (
  platform: Platform,
) => OAuthDriver | null | Promise<OAuthDriver | null>;

/**
 * Fixed failure reasons a driver may report.
 *
 * `denied` is a provider refusal such as a user decline, `invalid_response` is
 * a response the driver could not decode, and `unavailable` is a transport,
 * timeout or provider-availability failure. Free text never crosses this line.
 */
export type OAuthDriverFailureReason = "denied" | "invalid_response" | "unavailable";

const DRIVER_FAILURE_REASONS: readonly OAuthDriverFailureReason[] = Object.freeze([
  "denied",
  "invalid_response",
  "unavailable",
]);

export class OAuthDriverError extends Error {
  readonly reason: OAuthDriverFailureReason;

  public constructor(reason: OAuthDriverFailureReason) {
    super("the authorization driver could not complete the request");
    this.name = "OAuthDriverError";
    this.reason = reason;
  }
}

/**
 * Rebuild a documented driver failure, or return null.
 *
 * The instance itself is never trusted: only the allowlisted reason survives and
 * the result is a fresh value, so a forged subclass cannot smuggle text.
 */
export function preserveDriverFailure(error: unknown): OAuthDriverFailureReason | null {
  try {
    if (!(error instanceof OAuthDriverError)) {
      return null;
    }
    const reason: unknown = error.reason;
    return typeof reason === "string" &&
      (DRIVER_FAILURE_REASONS as readonly string[]).includes(reason)
      ? (reason as OAuthDriverFailureReason)
      : null;
  } catch {
    return null;
  }
}

/** Fixed codes persisted on a claimed authorization operation. */
export type OAuthStoredErrorCode =
  | "PROVIDER_DENIED"
  | "PROVIDER_FAILED"
  | "INVALID_RESPONSE"
  | "DECRYPTION_FAILED"
  | "CIPHER_UNAVAILABLE"
  | "EXPIRED"
  | "CONFIG_CHANGED"
  | "TOKEN_MISMATCH";

/** Stored code for one driver failure reason. */
export function storedErrorCodeFor(reason: OAuthDriverFailureReason | null): OAuthStoredErrorCode {
  switch (reason) {
    case "denied":
      return "PROVIDER_DENIED";
    case "invalid_response":
      return "INVALID_RESPONSE";
    default:
      return "PROVIDER_FAILED";
  }
}

/**
 * Closed allowlist of candidate configuration names.
 *
 * These are the explicit target fields a confirmation may still require from
 * the operator. Missing runtime app configuration is a resolver/start failure,
 * never a candidate requirement, so an arbitrary string cannot enter a DTO
 * through this list.
 */
export const OAUTH_CANDIDATE_FIELDS: readonly string[] = Object.freeze([
  "author",
  "api_version",
  "blog",
]);

/**
 * Validate a driver-supplied missing-field list, or return null.
 *
 * Duplicates and any name outside the closed allowlist are rejected instead of
 * being passed through to a status projection.
 */
export function safeMissingFields(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > OAUTH_CANDIDATE_FIELDS.length) {
    return null;
  }
  const fields: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !OAUTH_CANDIDATE_FIELDS.includes(entry)) {
      return null;
    }
    if (fields.includes(entry)) {
      return null;
    }
    fields.push(entry);
  }
  return Object.freeze(fields);
}
