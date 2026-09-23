/**
 * Credential slot + authorization operation port.
 *
 * Slot and payload revisions are independent: slot bookkeeping (leases,
 * binding, expiry) never invalidates an envelope's AAD, while a payload change
 * always increments `payloadRevision`.
 */

import type { Platform } from "@syndroo/core";

import type {
  ActivationCommit,
  ActivationResult,
  AuthOperationStart,
  CandidateCommit,
  EncryptedSlotSnapshot,
  OAuthClaim,
  OAuthClaimResult,
  RefreshClaim,
  RefreshClaimResult,
  RefreshCommit,
  RefreshFailure,
  SlotMutation,
  SlotMutationResult,
  StoredAuthOperation,
} from "../contracts/credentials.js";
import type { CleanupResult, CommitResult, MaintenanceBudget } from "../contracts/primitives.js";

export interface SlotLookup {
  readonly platform: Platform;
}

export interface AuthOperationLookup {
  readonly operationId: string;
}

export interface AuthOperationStateLookup {
  readonly platform: Platform;
  /** One-time OAuth `state` as received by the public callback. */
  readonly oauthState: string;
}

export interface CredentialStore {
  /** Absent slot returns status `empty` with revision 0; it never throws. */
  readSlot(input: SlotLookup): Promise<EncryptedSlotSnapshot>;

  /**
   * Guarded slot write: direct set, controlled plaintext migration or removal
   * (tombstone). A zero-row CAS leaves the slot, its envelope and its lease
   * completely unchanged.
   *
   * There is no implicit replay: every satisfied call bumps the revision, and
   * a repeated call with an already-consumed revision conflicts. A direct set
   * always establishes a new connection (binding and target included), and a
   * remove always bumps the revision even when the slot is already a
   * tombstone, so an authorization created at the previous revision cannot be
   * completed after a later delete.
   */
  compareAndSetSlot(input: SlotMutation): Promise<SlotMutationResult>;

  /** Create the short-lived operation record for an authorized connect. */
  createAuthOperation(input: AuthOperationStart): Promise<void>;

  /**
   * Single-winner claim of `pending_callback` -> `exchanging`, keyed by the
   * callback's `state` (the operation id is never a callback credential).
   * Matches platform, state, expiry, start configuration and (OAuth1) request
   * token. A failed exchange is never restored to `pending_callback`.
   */
  claimOAuthCallback(input: OAuthClaim): Promise<OAuthClaimResult>;

  /**
   * Narrow read used by the callback path before claiming, so the handler can
   * resolve a state to an operation without holding the operation id.
   */
  findAuthOperationByState(input: AuthOperationStateLookup): Promise<StoredAuthOperation | null>;

  /** Persist the candidate (or failure) produced by the token exchange. */
  saveCandidate(input: CandidateCommit): Promise<CommitResult>;

  /**
   * Activate a confirmed candidate: active encrypted credential + new binding +
   * incremented revision + operation receipt, all or nothing. Repeating a
   * completed operation replays its stored receipt and never activates again.
   *
   * `expectedRevision` must match both the operation's initial revision and the
   * current slot revision, so a newer slot value cannot revive an old
   * authorization; `currentConfigBinding` must match the operation's start
   * configuration.
   */
  activateCandidate(input: ActivationCommit): Promise<ActivationResult>;

  /**
   * Acquire the persistent refresh lease before any external exchange. Only the
   * winner may call the provider; losers get `conflict` with zero external work.
   */
  acquireRefresh(input: RefreshClaim): Promise<RefreshClaimResult>;

  /**
   * Write the refreshed envelope while the lease token and slot revision still
   * match, preserving target metadata and binding. A late result conflicts.
   */
  completeRefresh(input: RefreshCommit): Promise<CommitResult>;

  /**
   * Record a refresh attempt that produced no usable token. An unknown external
   * result marks the slot `reconnect_required`, which blocks further automatic
   * refreshes until an explicit set/remove/complete replaces the connection.
   */
  markReconnectRequired(input: RefreshFailure): Promise<CommitResult>;

  /** Internal record including secret material; never returned to clients. */
  readAuthOperation(input: AuthOperationLookup): Promise<StoredAuthOperation | null>;

  /**
   * Expire operations past their TTL and clear residual request/candidate
   * secrets, never an active slot.
   *
   * Completed operations keep their receipt for replay; only rows that never
   * reached a terminal phase are transitioned to `expired`. The eligible set
   * is selected before the budget is applied, so an unexpired low-id row cannot
   * starve cleanup work. A row that both holds residual secrets and needs the
   * phase change is mutated once, and the reported count is the number of rows
   * actually changed.
   */
  cleanupExpired(input: MaintenanceBudget): Promise<CleanupResult>;
}
