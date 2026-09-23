/**
 * Credential slot, OAuth operation and refresh-lease contracts.
 *
 * Slot `revision` fences writes; `payloadRevision` fences the encrypted AAD and
 * is independent of slot bookkeeping, so lease metadata changes never
 * invalidate an existing envelope.
 */

import type { Platform } from "@syndroo/core";

import type { CommitConflictReason, CommitResult, IsoInstant } from "./primitives.js";
import type { AuthPhase, CompleteReceiptRecord, SafeTarget } from "./status.js";

export const CIPHER_ENVELOPE_VERSION = 1;
export const CIPHER_ALGORITHM = "AES-256-GCM";
export const CIPHER_AAD_PREFIX = "syndroo-credential";
export const CIPHER_AAD_VERSION = 1;

export type CipherPurpose =
  | "active_slot"
  | "oauth_request_secret"
  | "oauth_candidate"
  | "pkce_verifier";

export interface EncryptedCredential {
  readonly version: typeof CIPHER_ENVELOPE_VERSION;
  readonly algorithm: typeof CIPHER_ALGORITHM;
  readonly keyId: string;
  /** Base64 of the per-envelope random 12-byte IV. */
  readonly iv: string;
  /** Base64 of ciphertext followed by the 16-byte authentication tag. */
  readonly ciphertext: string;
}

export interface CipherContext {
  readonly purpose: CipherPurpose;
  readonly recordId: string;
  readonly platform: Platform;
  readonly payloadSchemaVersion: number;
  readonly payloadRevision: number;
}

/**
 * Fixed AAD tuple. Order and version are part of the crypto contract: changing
 * them invalidates every stored envelope on purpose.
 */
export function cipherAadTuple(context: CipherContext): readonly (string | number)[] {
  return Object.freeze([
    CIPHER_AAD_PREFIX,
    CIPHER_AAD_VERSION,
    context.purpose,
    context.recordId,
    context.platform,
    context.payloadSchemaVersion,
    context.payloadRevision,
  ]);
}

export function encodeCipherAad(context: CipherContext): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(cipherAadTuple(context)));
}

export type SlotStatus = "empty" | "active" | "tombstone";

/**
 * Persistent refresh health for a slot.
 *
 * `reconnect_required` is sticky until an explicit direct set/remove/complete
 * replaces the connection: an expired lease alone never re-authorizes reuse of
 * a refresh token whose exchange result is unknown.
 */
export type RefreshState = "ready" | "reconnect_required";

export interface RefreshLease {
  readonly token: string;
  readonly acquiredAt: IsoInstant;
  readonly expiresAt: IsoInstant;
  /** Slot revision the lease was acquired against. */
  readonly revision: number;
}

export interface EncryptedSlotSnapshot {
  readonly platform: Platform;
  readonly status: SlotStatus;
  readonly revision: number;
  readonly bindingId: string | null;
  readonly envelope: EncryptedCredential | null;
  readonly payloadRevision: number | null;
  readonly payloadSchemaVersion: number | null;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
  readonly refreshLease: RefreshLease | null;
  readonly refreshState: RefreshState;
  /**
   * Identity of the last committed refresh for exact replay detection. A
   * repeated commit with the same identity and the already-advanced revision is
   * `already_applied`; anything else is a conflict.
   */
  readonly lastRefreshCommitFingerprint: string | null;
  readonly updatedAt: IsoInstant | null;
}

export interface CredentialEnvelopeWrite {
  readonly envelope: EncryptedCredential;
  readonly payloadRevision: number;
  readonly payloadSchemaVersion: number;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
}

export type SlotChange =
  | ({ readonly kind: "set"; readonly bindingId: string } & CredentialEnvelopeWrite)
  /** Controlled migration: write the envelope and clear plaintext atomically. */
  | ({ readonly kind: "migrate_plaintext"; readonly bindingId: string } & CredentialEnvelopeWrite)
  /** Clears token material and keeps a revisioned tombstone. */
  | { readonly kind: "remove" };

export interface SlotMutation {
  readonly platform: Platform;
  readonly expectedRevision: number;
  readonly now: IsoInstant;
  readonly change: SlotChange;
}

export type SlotMutationResult =
  | { readonly kind: "applied"; readonly revision: number }
  | { readonly kind: "already_applied"; readonly revision: number }
  | { readonly kind: "conflict"; readonly reason: CommitConflictReason };

export interface AuthOperationStart {
  readonly operationId: string;
  readonly platform: Platform;
  readonly now: IsoInstant;
  readonly expectedRevision: number;
  readonly canonicalCallbackUrl: string;
  /** Fingerprint of the instance/platform config the operation started from. */
  readonly startConfigBinding: string;
  readonly oauthState: string;
  readonly requestToken: string | null;
  readonly requestSecret: EncryptedCredential | null;
  readonly requestSecretPurpose: CipherPurpose | null;
  readonly requestSecretRevision: number | null;
  readonly expiresAt: IsoInstant;
}

/**
 * Internal operation record. Structurally satisfies
 * `AuthOperationProjectionSource`; the projection function is the only
 * supported way to expose it.
 */
export interface StoredAuthOperation {
  readonly operationId: string;
  readonly platform: Platform;
  readonly phase: AuthPhase;
  readonly expectedRevision: number;
  readonly canonicalCallbackUrl: string;
  readonly startConfigBinding: string;
  readonly oauthState: string;
  readonly requestToken: string | null;
  readonly requestSecret: EncryptedCredential | null;
  readonly requestSecretPurpose: CipherPurpose | null;
  readonly requestSecretRevision: number | null;
  readonly candidateEnvelope: EncryptedCredential | null;
  readonly candidatePayloadRevision: number | null;
  readonly candidatePayloadSchemaVersion: number | null;
  readonly candidateTarget: SafeTarget | null;
  readonly receipt: CompleteReceiptRecord | null;
  readonly missingFields: readonly string[];
  readonly errorCode: string | null;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  readonly expiresAt: IsoInstant;
}

export interface OAuthClaim {
  readonly platform: Platform;
  /** Public callback input: the one-time `state` value, not the operation id. */
  readonly oauthState: string;
  readonly requestToken: string | null;
  readonly now: IsoInstant;
  /** Config fingerprint observed at callback time; must match the start value. */
  readonly currentConfigBinding: string;
}

export type OAuthClaimConflictReason =
  | "not_found"
  | "platform_mismatch"
  | "state_mismatch"
  | "request_token_mismatch"
  | "phase_mismatch"
  | "expired"
  | "start_config_changed";

export type OAuthClaimResult =
  | { readonly kind: "claimed"; readonly operation: StoredAuthOperation }
  | { readonly kind: "conflict"; readonly reason: OAuthClaimConflictReason }
  /** The claim write result is unknown; the caller must not exchange tokens. */
  | { readonly kind: "unknown" };

export interface CandidateCommit {
  readonly operationId: string;
  readonly platform: Platform;
  readonly now: IsoInstant;
  readonly outcome:
    | {
        readonly kind: "candidate";
        readonly phase: "awaiting_confirmation" | "needs_configuration";
        readonly candidateEnvelope: EncryptedCredential;
        readonly candidatePayloadRevision: number;
        readonly candidatePayloadSchemaVersion: number;
        readonly candidateTarget: SafeTarget | null;
        readonly missingFields: readonly string[];
      }
    | { readonly kind: "failed"; readonly errorCode: string };
}

export interface ActivationCommit {
  readonly operationId: string;
  readonly platform: Platform;
  readonly now: IsoInstant;
  /** Slot revision the operator observed; stale confirmations must conflict. */
  readonly expectedRevision: number;
  /** A completed authorization always establishes a new binding. */
  readonly bindingId: string;
  /** Config fingerprint observed at complete time; must match the start value. */
  readonly currentConfigBinding: string;
  readonly envelope: EncryptedCredential;
  readonly payloadRevision: number;
  readonly payloadSchemaVersion: number;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
  readonly receipt: CompleteReceiptRecord;
}

export type ActivationConflictReason =
  | "not_found"
  | "platform_mismatch"
  | "phase_mismatch"
  | "revision_mismatch"
  | "operation_expired"
  | "start_config_changed"
  | "target_required";

export type ActivationResult =
  | { readonly kind: "activated"; readonly revision: number; readonly receipt: CompleteReceiptRecord }
  | { readonly kind: "replayed"; readonly revision: number; readonly receipt: CompleteReceiptRecord }
  | { readonly kind: "conflict"; readonly reason: ActivationConflictReason };

export interface RefreshClaim {
  readonly platform: Platform;
  readonly expectedRevision: number;
  readonly leaseToken: string;
  readonly now: IsoInstant;
  readonly leaseDurationMs: number;
}

export type RefreshClaimConflictReason =
  | "not_found"
  | "revision_mismatch"
  | "lease_held"
  | "tombstone"
  | "no_refresh_payload"
  | "reconnect_required";

export type RefreshClaimResult =
  | { readonly kind: "acquired"; readonly snapshot: EncryptedSlotSnapshot; readonly lease: RefreshLease }
  | { readonly kind: "conflict"; readonly reason: RefreshClaimConflictReason }
  /** The lease write result is unknown; no external exchange may start. */
  | { readonly kind: "unknown" };

export interface RefreshCommit {
  readonly platform: Platform;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly now: IsoInstant;
  readonly envelope: EncryptedCredential;
  readonly payloadRevision: number;
  readonly payloadSchemaVersion: number;
  readonly expiresAt: IsoInstant | null;
  /** Target metadata is preserved across a refresh; it never changes binding. */
  readonly target: SafeTarget | null;
}

export type RefreshCommitResult = CommitResult;

/**
 * Explicit outcome of a refresh attempt that did not produce a usable token.
 *
 * `unknown_result` (external exchange may have rotated the token) marks the
 * slot `reconnect_required`; an expired lease alone never does.
 */
export interface RefreshFailure {
  readonly platform: Platform;
  readonly leaseToken: string;
  /** Slot revision the failed exchange was authorised against. */
  readonly expectedRevision: number;
  readonly now: IsoInstant;
  readonly reason: "unknown_result" | "provider_rejected" | "invalid_response";
}

/**
 * Deterministic identity of a refresh commit.
 *
 * Covers the lease token, revision and every semantic field, so a replay is
 * only recognised when the caller resends the identical request. `now` is
 * excluded because a retry legitimately carries a later timestamp.
 */
export function refreshCommitFingerprint(input: RefreshCommit): string {
  return JSON.stringify([
    "refresh",
    input.leaseToken,
    input.expectedRevision,
    input.envelope.version,
    input.envelope.algorithm,
    input.envelope.keyId,
    input.envelope.iv,
    input.envelope.ciphertext,
    input.payloadRevision,
    input.payloadSchemaVersion,
    input.expiresAt,
    input.target?.label ?? null,
    input.target?.source ?? null,
  ]);
}
