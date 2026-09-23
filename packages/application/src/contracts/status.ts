/**
 * Safe credential/auth projections.
 *
 * These shapes mirror `docs/v0.5.0/public-api.md` field for field so that the
 * HTTP layer never invents a second, divergent status contract. They are
 * deliberately narrower than the stored records: binding identifiers, OAuth
 * state, request secrets, encrypted envelopes and token material never appear
 * here.
 */

import type { Platform } from "@syndroo/core";

import { compareInstants, type IsoInstant } from "./primitives.js";

export type Readiness =
  | "ready"
  | "missing_credentials"
  | "needs_configuration"
  | "expired"
  | "reconnect_required"
  | "unavailable";

export type CredentialSource = "env" | "credential" | "mixed" | null;

/**
 * Decoded public identifier (author/blog/host).
 *
 * This type carries no sanitization of its own: the platform resolver or
 * decoder must validate the value before constructing it, and `source` records
 * whether the user chose it or the provider confirmed it. Never place raw
 * provider text or token material here.
 */
export interface SafeTarget {
  readonly label: string;
  readonly source: "user" | "provider";
}

/**
 * Public-shaped platform status. `configured` is the compatibility projection
 * of local readiness and never claims that a real account was verified.
 */
export interface SafePlatformStatus {
  readonly platform: Platform;
  readonly configured: boolean;
  readonly source: CredentialSource;
  readonly oauthSupported: boolean;
  readonly readiness: Readiness;
  readonly missingFields: readonly string[];
  readonly expiresAt: IsoInstant | null;
  readonly revision: number;
  readonly target?: SafeTarget;
}

export type AuthPhase =
  | "pending_callback"
  | "exchanging"
  | "awaiting_confirmation"
  | "needs_configuration"
  | "completed"
  | "failed"
  | "expired";

/** Receipt for direct set/remove/refresh mutations. */
export type AuthMutationReceipt =
  | {
      readonly platform: Platform;
      readonly action: "stored";
      readonly revision: number;
      readonly configured: boolean;
      readonly readiness: Readiness;
    }
  | {
      readonly platform: Platform;
      readonly action: "removed";
      readonly revision: number;
      readonly configured: boolean;
      readonly readiness: Readiness;
    }
  | {
      readonly platform: Platform;
      readonly action: "refreshed";
      readonly revision: number;
      readonly configured: boolean;
      readonly readiness: Readiness;
      readonly expiresAt: IsoInstant | null;
    };

/**
 * Stored receipt of a completed authorization. Written atomically with
 * activation and replayed verbatim on repeated `complete`.
 *
 * `readiness`/`configured` are resolver-produced safe values; this type does
 * not sanitize anything by itself.
 */
export interface CompleteReceiptRecord {
  readonly platform: Platform;
  readonly operationId: string;
  readonly stored: true;
  readonly revision: number;
  readonly configured: boolean;
  readonly readiness: Readiness;
  readonly replayed?: boolean;
}

/**
 * Minimal safe subset of a stored auth operation used for projection. The
 * stored record is structurally assignable to this interface.
 */
export interface AuthOperationProjectionSource {
  readonly operationId: string;
  readonly platform: Platform;
  readonly phase: AuthPhase;
  readonly expiresAt: IsoInstant;
  readonly expectedRevision: number;
  readonly missingFields: readonly string[];
  readonly candidateTarget: SafeTarget | null;
  readonly receipt: CompleteReceiptRecord | null;
  /** Fixed safe code produced by the resolver; this type does not sanitize it. */
  readonly errorCode: string | null;
}

export interface AuthOperationProjection {
  readonly platform: Platform;
  readonly operationId: string;
  readonly phase: AuthPhase;
  readonly expiresAt: IsoInstant;
  readonly expectedRevision: number;
  readonly missingFields: readonly string[];
  readonly candidate?: { readonly target?: SafeTarget };
  readonly active: SafePlatformStatus;
  readonly receipt?: CompleteReceiptRecord;
  readonly errorCode?: string;
}

/**
 * Project a stored operation into its public shape. Only allowlisted metadata
 * is copied; OAuth state, request tokens, verifiers and encrypted envelopes
 * can never travel through this function.
 */
export function projectAuthOperation(input: {
  readonly operation: AuthOperationProjectionSource;
  readonly active: SafePlatformStatus;
  /**
   * Observation time. When supplied, an operation past its TTL is projected as
   * expired and never exposes a candidate; the stored record is not mutated.
   */
  readonly now?: IsoInstant;
}): AuthOperationProjection {
  const { operation, active, now } = input;
  const expired = now !== undefined && compareInstants(now, operation.expiresAt) >= 0;
  const terminalPhase =
    operation.phase === "completed" ||
    operation.phase === "failed" ||
    operation.phase === "expired";
  const phase: AuthPhase = expired && !terminalPhase ? "expired" : operation.phase;
  const candidate: { readonly target?: SafeTarget } | null =
    expired || operation.candidateTarget === null ? null : { target: operation.candidateTarget };
  return Object.freeze({
    platform: operation.platform,
    operationId: operation.operationId,
    phase,
    expiresAt: operation.expiresAt,
    expectedRevision: operation.expectedRevision,
    missingFields: Object.freeze([...operation.missingFields]),
    ...(candidate === null ? {} : { candidate: Object.freeze(candidate) }),
    active,
    ...(operation.receipt === null ? {} : { receipt: operation.receipt }),
    ...(operation.errorCode === null ? {} : { errorCode: operation.errorCode }),
  });
}
