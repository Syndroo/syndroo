/**
 * Runtime-neutral primitives shared by every 0.5.0 application port.
 *
 * Nothing in this package may import Cloudflare, Node or provider modules.
 * Ports exchange plain TypeScript values, normalized UTC instants and
 * standard typed arrays only; SQL, bindings and broker acknowledgements stay
 * inside the outer adapters.
 */

/**
 * Canonical UTC ISO-8601 instant: exactly what `Date.prototype.toISOString()`
 * emits, for example `2026-09-23T00:00:00.000Z`.
 *
 * Canonical form matters because D1 stores these as TEXT and compares them
 * lexicographically. Requests carrying offsets, missing milliseconds or
 * out-of-range calendar dates must be normalized at the decode boundary
 * before they reach a port.
 */
export type IsoInstant = string;

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const MAX_ID_LENGTH = 128;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Invalid caller input: a programming error, never a storage failure. */
export class InvalidContractInputError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidContractInputError";
  }
}

/** Transient storage/broker failure. Callers map this to infrastructure retry. */
export class StoreUnavailable extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreUnavailable";
  }
}

/** A persisted record exists but is corrupt or fails its own contract. */
export class CorruptStoreRecordError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptStoreRecordError";
  }
}

export function isIsoInstant(value: unknown): value is IsoInstant {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) {
    return false;
  }
  // Rejects impossible calendar dates (for example 2026-02-30) that a parser
  // may otherwise normalize, and any non-canonical rendering.
  return new Date(parsedMs).toISOString() === value;
}

export function requireIsoInstant(value: unknown, label: string): IsoInstant {
  if (!isIsoInstant(value)) {
    throw new InvalidContractInputError(`${label} must be a normalized UTC ISO instant`);
  }
  return value;
}

export function compareInstants(left: IsoInstant, right: IsoInstant): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (leftMs === rightMs) {
    return 0;
  }
  return leftMs < rightMs ? -1 : 1;
}

/** True when `at` is reached at `now` (inclusive). */
export function isDueAt(at: IsoInstant, now: IsoInstant): boolean {
  return compareInstants(at, now) <= 0;
}

export function isOpaqueId(value: unknown, maxLength: number = MAX_ID_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    OPAQUE_ID_PATTERN.test(value)
  );
}

export function requireOpaqueId(
  value: unknown,
  label: string,
  maxLength: number = MAX_ID_LENGTH,
): string {
  if (!isOpaqueId(value, maxLength)) {
    throw new InvalidContractInputError(`${label} must be a bounded opaque identifier`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Commit outcomes
// ---------------------------------------------------------------------------

export type CommitConflictReason =
  | "not_found"
  | "revision_mismatch"
  | "guard_mismatch"
  | "already_claimed"
  | "terminal"
  | "attempt_budget_exhausted"
  | "duplicate_attempt"
  | "lease_mismatch"
  | "phase_mismatch"
  | "operation_expired"
  | "target_required"
  | "reconnect_required";

/**
 * Result of a guarded semantic transaction.
 *
 * `applied` means the caller's write was committed. `already_applied` means an
 * identical earlier write of the same logical operation was replayed and the
 * store performed no second state transition. `conflict` means no row changed:
 * the caller must re-read authoritative state before deciding anything else.
 */
export type CommitResult =
  | { readonly kind: "applied" }
  | { readonly kind: "already_applied" }
  | { readonly kind: "conflict"; readonly reason: CommitConflictReason };

export const COMMIT_APPLIED: CommitResult = Object.freeze({ kind: "applied" });
export const COMMIT_ALREADY_APPLIED: CommitResult = Object.freeze({ kind: "already_applied" });

export function commitConflict(reason: CommitConflictReason): CommitResult {
  return Object.freeze({ kind: "conflict", reason });
}

// ---------------------------------------------------------------------------
// Maintenance budgets and reports
// ---------------------------------------------------------------------------

export interface MaintenanceBudget {
  readonly now: IsoInstant;
  readonly limit: number;
}

export function requireMaintenanceBudget(input: MaintenanceBudget): MaintenanceBudget {
  requireIsoInstant(input.now, "MaintenanceBudget.now");
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new InvalidContractInputError("MaintenanceBudget.limit must be a positive safe integer");
  }
  return input;
}

export interface CleanupResult {
  readonly removed: number;
}

export interface RecoveryResult {
  readonly examined: number;
  readonly staleClaimsMarkedUnknown: number;
  readonly jobsRearmed: number;
  readonly jobsDeadLettered: number;
  readonly skipped: number;
}

export const EMPTY_RECOVERY_RESULT: RecoveryResult = Object.freeze({
  examined: 0,
  staleClaimsMarkedUnknown: 0,
  jobsRearmed: 0,
  jobsDeadLettered: 0,
  skipped: 0,
});

// ---------------------------------------------------------------------------
// Application-level consumer outcome
// ---------------------------------------------------------------------------

export type ConsumerSettledReason =
  | "executed"
  | "duplicate"
  | "stale_job"
  | "terminal"
  | "dead_lettered"
  | "pre_execution_rejected"
  | "dlq_recorded"
  | "not_due";

export type ConsumerRetryReason =
  | "store_unavailable"
  | "malformed_envelope"
  | "rearm_write_failed"
  | "preparation_deferred"
  | "dlq_metadata_write_failed";

/**
 * What a portable consumer returns to the runtime. Broker acknowledgement,
 * retry delay and DLQ movement are runtime concerns and never appear here.
 */
export type ConsumerOutcome =
  | { readonly kind: "settled"; readonly reason: ConsumerSettledReason }
  | { readonly kind: "infrastructure_retry"; readonly reason: ConsumerRetryReason };

// ---------------------------------------------------------------------------
// Shared policy constants (single source for application and adapters)
// ---------------------------------------------------------------------------

/** Total Publisher executions allowed per Publication, including the first. */
export const PUBLISHER_MAX_ATTEMPTS = 3;

/** Default business retry delays after attempt 1 and attempt 2. */
export const DEFAULT_RETRY_DELAYS_MS: readonly [number, number] = [60_000, 120_000];

/** A claim older than this without a result is recovered as unknown. */
export const STALE_CLAIM_WINDOW_MS = 15 * 60_000;

/** Minimum wait before a dispatched-but-never-claimed current job may be rearmed. */
export const STALLED_RECOVERY_MIN_WAIT_MS = 30 * 60_000;

/** Automatic stalled-transport recoveries allowed per OutboxJob. */
export const MAX_STALLED_RECOVERIES = 3;

/** Persisted refresh lease window; never an automatic retry licence. */
export const REFRESH_LEASE_MS = 60_000;

/** Single OAuth token request deadline. */
export const PROVIDER_REQUEST_DEADLINE_MS = 15_000;

/** Auth operation TTL counted from connect creation; reads never renew it. */
export const AUTH_OPERATION_TTL_MS = 30 * 60_000;

/** Finished (cancelled) outbox intents are collectable after this delay. */
export const OUTBOX_FINISHED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Archive retention policy for provider diagnostics. */
export const PROVIDER_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Archive retention policy for DLQ diagnostics. */
export const DLQ_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60_000;
