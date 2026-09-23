/**
 * Pure execution policy for the portable consumer.
 *
 * Everything here is decision logic and fixed encodings: no store, queue,
 * provider, clock or archive call happens in this module. Untrusted provider
 * results are reduced to an allowlisted code, an ambiguity flag and an optional
 * canonical retry hint; messages, causes and raw bodies are never read.
 */

import { PublishError, type Platform, type PublishErrorCode } from "@syndroo/core";

import type { TerminalReason } from "../contracts/execution.js";
import {
  DEFAULT_RETRY_DELAYS_MS,
  InvalidContractInputError,
  PUBLISHER_MAX_ATTEMPTS,
  PROVIDER_ARCHIVE_RETENTION_MS,
  compareInstants,
  isIsoInstant,
  isOpaqueId,
  type ConsumerOutcome,
  type ConsumerRetryReason,
  type ConsumerSettledReason,
  type IsoInstant,
} from "../contracts/primitives.js";
import {
  ARCHIVE_CODES,
  ARCHIVE_REDACTION_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  assertSanitizedArchive,
  isSafeArchiveKey,
  type ArchiveCode,
  type ArchiveKey,
  type ArchiveOutcome,
  type SanitizedArchive,
} from "../contracts/storage.js";

/** Identity the consumer needs; claims, attempts and jobs are distinct kinds. */
export type ExecutionIdKind = "claim" | "attempt" | "job";
export type ExecutionIdFactory = (kind: ExecutionIdKind) => string;

export function nextExecutionId(ids: ExecutionIdFactory, kind: ExecutionIdKind): string {
  const value = ids(kind);
  if (!isOpaqueId(value)) {
    throw new InvalidContractInputError(
      "id factory must return a bounded opaque identifier",
    );
  }
  return value;
}

export function settled(reason: ConsumerSettledReason): ConsumerOutcome {
  return Object.freeze({ kind: "settled" as const, reason });
}

export function infrastructureRetry(reason: ConsumerRetryReason): ConsumerOutcome {
  return Object.freeze({ kind: "infrastructure_retry" as const, reason });
}

/** Complete set of provider error codes a typed failure may contribute. */
export const PUBLISH_ERROR_CODES: readonly PublishErrorCode[] = Object.freeze([
  "AUTH",
  "RATE_LIMIT",
  "INVALID_CONTENT",
  "PROVIDER_UNAVAILABLE",
  "NETWORK",
  "UNKNOWN",
]);

/**
 * Codes whose unambiguous failure the design lets the application retry: rate
 * limits, provider unavailability and unambiguous network failures.
 */
export const SAFE_RETRY_CODES: readonly PublishErrorCode[] = Object.freeze([
  "RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "NETWORK",
]);

/** Allowlisted view of one provider failure. */
export interface PublishFailureView {
  readonly code: PublishErrorCode;
  readonly ambiguous: boolean;
  readonly retryAfterAt: IsoInstant | null;
}

/**
 * Reduce any thrown provider result to a safe view.
 *
 * A typed `PublishError` contributes only an allowlisted code, an explicit
 * boolean ambiguity flag and a canonical `retryAfterAt`. Conservative rules:
 *
 * - anything that is not a typed `PublishError` — a raw string, a transport
 *   cause, a provider body, a forged class — is an ambiguous UNKNOWN, because
 *   an unrecognised throw is never proof that the remote platform did not write
 * - an UNKNOWN or non-allowlisted code is *always* ambiguous, even if the flag
 *   claims otherwise, so ambiguous evidence can never decay into a retry or a
 *   clean rejection
 * - only the literal boolean `false` proves "no side effect"; a missing,
 *   non-boolean or malformed flag stays ambiguous
 * - reading the typed fields is itself guarded, so a hostile getter throwing
 *   (possibly with credential material in its message) reduces to UNKNOWN
 *   instead of escaping
 *
 * A valid canonical `retryAfterAt` is preserved as a hint only; it can never
 * make an ambiguous result retryable.
 */
export function normalizePublishFailure(error: unknown): PublishFailureView {
  const unknown = Object.freeze({
    code: "UNKNOWN" as const,
    ambiguous: true,
    retryAfterAt: null,
  });
  if (!(error instanceof PublishError)) {
    return unknown;
  }
  try {
    const declared = error.code;
    const code: PublishErrorCode = PUBLISH_ERROR_CODES.includes(declared) ? declared : "UNKNOWN";
    const hint = error.retryAfterAt;
    const retryAfterAt =
      typeof hint === "string" && isIsoInstant(hint) ? hint : null;
    // Only an explicit `false` on a *known* code may claim "nothing was sent".
    const ambiguous = code !== "UNKNOWN" && error.ambiguous === false ? false : true;
    return Object.freeze({ code, ambiguous, retryAfterAt });
  } catch {
    // A throwing accessor is an unrecognised result: fail closed, keep nothing.
    return unknown;
  }
}

export interface RetrySchedule {
  readonly kind: "retry";
  readonly retryAt: IsoInstant;
  readonly nextAttemptNo: number;
}

export interface TerminalDecision {
  readonly kind: "terminal";
  readonly terminalReason: TerminalReason;
  readonly errorCode: PublishErrorCode | null;
  readonly errorAmbiguous: boolean;
}

export type FailureDecision = RetrySchedule | TerminalDecision;

export interface FailureDecisionInput {
  readonly failure: PublishFailureView;
  /** Publisher executions already consumed, including the attempt that failed. */
  readonly attempts: number;
  readonly now: IsoInstant;
}

function terminalDecision(
  terminalReason: TerminalReason,
  errorCode: PublishErrorCode | null,
  errorAmbiguous: boolean,
): TerminalDecision {
  return Object.freeze({ kind: "terminal" as const, terminalReason, errorCode, errorAmbiguous });
}

function addMilliseconds(base: IsoInstant, offsetMs: number): IsoInstant {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

/**
 * Decide the durable outcome of one failed provider attempt.
 *
 * - unknown/ambiguous results are terminal `unknown` with `errorAmbiguous`
 * - unambiguous safe codes retry while the attempt budget allows, at the later
 *   of the default 60s/120s delay and a valid, still-future provider hint
 * - a valid later hint is honoured as-is: this release does not truncate it to
 *   an arbitrary ceiling, because the wait is persisted in D1 and never in a
 *   broker delay
 * - unambiguous non-safe codes are terminal `provider_rejected`
 * - an exhausted safe budget is terminal `attempts_exhausted`
 */
export function decideFailureOutcome(input: FailureDecisionInput): FailureDecision {
  if (!Number.isSafeInteger(input.attempts) || input.attempts <= 0) {
    throw new InvalidContractInputError("attempts must be a positive safe integer");
  }
  const { failure, now } = input;
  if (failure.ambiguous || failure.code === "UNKNOWN") {
    // Unknown evidence is never retried and never reported as a clean failure.
    return terminalDecision("unknown", failure.code, true);
  }
  if (!SAFE_RETRY_CODES.includes(failure.code)) {
    return terminalDecision("provider_rejected", failure.code, false);
  }
  if (input.attempts >= PUBLISHER_MAX_ATTEMPTS) {
    return terminalDecision("attempts_exhausted", failure.code, false);
  }
  const defaultDelay = DEFAULT_RETRY_DELAYS_MS[input.attempts - 1] ?? DEFAULT_RETRY_DELAYS_MS[1];
  const baseline = addMilliseconds(now, defaultDelay);
  const hint =
    failure.retryAfterAt !== null && compareInstants(failure.retryAfterAt, now) > 0
      ? failure.retryAfterAt
      : null;
  const retryAt = hint !== null && compareInstants(hint, baseline) > 0 ? hint : baseline;
  return Object.freeze({
    kind: "retry" as const,
    retryAt,
    nextAttemptNo: input.attempts + 1,
  });
}

/**
 * External identifiers may be stored, so they are bounded and control-free.
 * Anything else becomes null rather than being persisted verbatim.
 */
export function safeProviderIdentifier(value: unknown, maxLength = 2048): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return null;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Archive planning
// ---------------------------------------------------------------------------

export interface ArchivePlan {
  readonly key: ArchiveKey;
  readonly payload: SanitizedArchive;
}

/** Deterministic logical key; only the design's allowlisted prefix is used. */
export function plannedArchiveKey(input: {
  readonly now: IsoInstant;
  readonly publicationId: string;
  readonly attemptId: string;
}): ArchiveKey {
  const date = new Date(Date.parse(input.now));
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const key = `archive/provider-responses/${year}/${month}/${input.publicationId}/${input.attemptId}.json`;
  if (!isSafeArchiveKey(key)) {
    throw new InvalidContractInputError("planned archive key is not an allowlisted logical key");
  }
  return key;
}

/** Allowlist an archive diagnostic code; unknown values are dropped. */
export function archiveCodeOf(value: unknown): ArchiveCode | null {
  return typeof value === "string" && ARCHIVE_CODES.includes(value as ArchiveCode)
    ? (value as ArchiveCode)
    : null;
}

export function archiveMetadataForPublished(): {
  readonly outcome: ArchiveOutcome;
  readonly code: ArchiveCode | null;
} {
  return Object.freeze({ outcome: "published" as const, code: null });
}

export function archiveMetadataForFailure(
  failure: PublishFailureView,
  decision: FailureDecision,
): { readonly outcome: ArchiveOutcome; readonly code: ArchiveCode | null } {
  const code: ArchiveCode | null = archiveCodeOf(failure.code);
  if (decision.kind === "retry") {
    return Object.freeze({ outcome: "retry" as const, code });
  }
  switch (decision.terminalReason) {
    case "provider_rejected":
      return Object.freeze({ outcome: "rejected" as const, code });
    case "attempts_exhausted":
      return Object.freeze({ outcome: "failed" as const, code });
    default:
      return Object.freeze({ outcome: "unknown" as const, code });
  }
}

/**
 * Build the allowlisted archive object for one attempt.
 *
 * Only fixed enums, internal identifiers, an optional typed HTTP status and
 * timestamps appear here: there is no representation for provider text,
 * headers, bodies or credentials, and the storage boundary re-validates the
 * payload before it may be written.
 */
export function planArchive(input: {
  readonly now: IsoInstant;
  readonly publicationId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly platform: Platform;
  readonly outcome: ArchiveOutcome;
  readonly code: ArchiveCode | null;
  readonly httpStatus: number | null;
}): ArchivePlan {
  const key = plannedArchiveKey({
    now: input.now,
    publicationId: input.publicationId,
    attemptId: input.attemptId,
  });
  const expiresAt = new Date(
    Date.parse(input.now) + PROVIDER_ARCHIVE_RETENTION_MS,
  ).toISOString();
  const payload: SanitizedArchive = Object.freeze({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    category: "provider_response" as const,
    redactionVersion: ARCHIVE_REDACTION_VERSION,
    platform: input.platform,
    stage: "response" as const,
    outcome: input.outcome,
    httpStatus: input.httpStatus,
    code: input.code,
    publicationId: input.publicationId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    createdAt: input.now,
    expiresAt,
  });
  assertSanitizedArchive(payload);
  return Object.freeze({ key, payload });
}
