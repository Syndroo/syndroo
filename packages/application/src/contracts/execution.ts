/**
 * Publishing execution contracts: create transaction, immutable execution
 * snapshots, claim/revision fences, outcome commits, DLQ settlement and
 * bounded stale recovery.
 */

import type {
  Platform,
  PostStatus,
  PublicationStatus,
  PublishErrorCode,
} from "@syndroo/core";

import type { NewOutboxJobRecord, OutboxJob, TransportReason } from "./outbox.js";
import { isCreateIdempotencyKey } from "./idempotency.js";
import {
  InvalidContractInputError,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "./primitives.js";

export type { TransportReason };

export type TerminalReason =
  | "provider_rejected"
  | "attempts_exhausted"
  | "unknown"
  | "dead_lettered"
  | "binding_mismatch"
  | "legacy_unbound"
  | "invalid_configuration";

export type ArchiveStatus =
  | "not_requested"
  | "pending"
  | "available"
  | "failed"
  | "unavailable";

/** Planned logical archive key, persisted with the outcome before the R2 write. */
export interface PlannedArchive {
  readonly key: string;
}

/** Per-platform content overrides accepted by the existing create API. */
export type ContentOverrides = Readonly<
  Partial<Record<Platform, { readonly content?: string }>>
>;

// ---------------------------------------------------------------------------
// Immutable projections
// ---------------------------------------------------------------------------

export interface PostSnapshot {
  readonly id: string;
  readonly status: PostStatus;
  /** Immutable canonical content accepted at create time. */
  readonly content: string;
  /** Canonical platform intent, preserved for existing read/replay behavior. */
  readonly platforms: readonly Platform[];
  /** Per-platform override intent, preserved verbatim. */
  readonly overrides: ContentOverrides;
  /** Immutable original user intent. Retries never rewrite it. */
  readonly scheduledAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
}

/**
 * Compact identity of the committed outcome for replay detection.
 *
 * Carried on the publication so a repeated commit of the *same* logical
 * operation can answer `already_applied` without re-entering the provider,
 * while a commit belonging to a different attempt can never be mistaken for a
 * replay. `key` is the attempt id for claim-based commits and the job id for a
 * pre-execution rejection, which has no attempt.
 */
export interface CommittedOutcomeIdentity {
  readonly key: string;
  readonly fingerprint: string;
}

export interface PublicationSnapshot {
  readonly id: string;
  readonly postId: string;
  readonly platform: Platform;
  readonly provider: string;
  readonly content: string;
  readonly status: PublicationStatus;
  readonly attempts: number;
  readonly claimToken: string | null;
  readonly attemptId: string | null;
  readonly currentJobId: string | null;
  readonly retryAt: IsoInstant | null;
  readonly publishingAt: IsoInstant | null;
  readonly publishedAt: IsoInstant | null;
  /**
   * HMAC of the connection identity captured at create time. Distinct from the
   * credential slot's random `bindingId`.
   */
  readonly credentialBinding: string | null;
  /**
   * Slot revision observed when this publication was created. Informational
   * only: a later refresh must not permanently lock execution, so claim guards
   * compare the slot revision read during preparation instead.
   */
  readonly credentialRevisionAtCreate: number | null;
  readonly terminalReason: TerminalReason | null;
  readonly errorCode: PublishErrorCode | null;
  readonly errorAmbiguous: boolean;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly archiveKey: string | null;
  readonly archiveStatus: ArchiveStatus;
  readonly committedOutcome: CommittedOutcomeIdentity | null;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
}

/**
 * Frozen view handed to the consumer. The store must never mutate a snapshot
 * after returning it, so a prepared Publisher cannot be swapped mid-flight.
 */
export interface ExecutionSnapshot {
  readonly publication: PublicationSnapshot;
  readonly post: PostSnapshot;
  readonly job: OutboxJob;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface NewPostRecord {
  readonly id: string;
  readonly content: string;
  readonly platforms: readonly Platform[];
  readonly overrides: ContentOverrides;
  readonly scheduledAt: IsoInstant | null;
  readonly status: PostStatus;
  readonly createdAt: IsoInstant;
}

export interface NewPublicationRecord {
  readonly id: string;
  readonly postId: string;
  readonly platform: Platform;
  readonly provider: string;
  readonly content: string;
  readonly status: PublicationStatus;
  readonly scheduledAt: IsoInstant | null;
  readonly credentialBinding: string;
  readonly credentialRevision: number;
  readonly createdAt: IsoInstant;
}

export interface CredentialGuard {
  readonly platform: Platform;
  readonly expectedRevision: number;
  readonly bindingId: string | null;
}

export interface CreatePostTransaction {
  readonly scope: "posts.create.v1";
  /** Optional public header; null means the caller sent no idempotency key. */
  readonly idempotencyKey: string | null;
  /**
   * Opaque equality token produced by `canonicalCreateRequestFingerprint`.
   * The store never re-derives it from the request.
   */
  readonly requestFingerprint: string;
  readonly now: IsoInstant;
  readonly post: NewPostRecord;
  readonly publications: readonly NewPublicationRecord[];
  readonly jobs: readonly NewOutboxJobRecord[];
  readonly credentialGuards: readonly CredentialGuard[];
}

export interface PublicationSummary {
  readonly publicationId: string;
  readonly platform: Platform;
  readonly status: PublicationStatus;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly errorCode: PublishErrorCode | null;
  readonly errorAmbiguous: boolean;
  readonly terminalReason: TerminalReason | null;
}

/**
 * Stored idempotency record. The Post snapshot carries the *current* status so
 * a replay reports the same status a fresh read would.
 */
export interface IdempotentPostRecord {
  readonly scope: "posts.create.v1";
  readonly key: string | null;
  readonly requestFingerprint: string;
  readonly post: PostSnapshot;
  readonly publications: readonly PublicationSummary[];
  readonly jobIds: readonly string[];
  readonly createdAt: IsoInstant;
}

export type CreateConflictReason =
  | "credential_revision_mismatch"
  | "duplicate_publication"
  | "duplicate_job"
  | "duplicate_attempt"
  | "invalid_input";

export type CreateCommitResult =
  | { readonly kind: "created"; readonly record: IdempotentPostRecord }
  | { readonly kind: "replayed"; readonly record: IdempotentPostRecord }
  | { readonly kind: "conflict"; readonly reason: CreateConflictReason };

function requireInstantOrNull(value: unknown, label: string): void {
  if (value !== null && !isIsoInstant(value)) {
    throw new InvalidContractInputError(`${label} must be a canonical UTC instant or null`);
  }
}

function requireRevision(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidContractInputError(`${label} must be a nonnegative safe integer`);
  }
}

/** Structural validation shared by every store adapter. */
export function validateCreatePostTransaction(input: CreatePostTransaction): void {
  if (input.scope !== "posts.create.v1") {
    throw new InvalidContractInputError("create scope must be posts.create.v1");
  }
  if (input.idempotencyKey !== null && !isCreateIdempotencyKey(input.idempotencyKey)) {
    throw new InvalidContractInputError(
      "idempotencyKey must use 1-128 letters, digits, dots, underscores, colons or hyphens",
    );
  }
  if (typeof input.requestFingerprint !== "string" || input.requestFingerprint.length === 0) {
    throw new InvalidContractInputError("requestFingerprint must be a non-empty string");
  }
  if (!isIsoInstant(input.now)) {
    throw new InvalidContractInputError("create now must be a canonical UTC instant");
  }
  if (!isOpaqueId(input.post.id)) {
    throw new InvalidContractInputError("post.id must be a bounded opaque identifier");
  }
  if (input.post.status !== "queued" && input.post.status !== "scheduled") {
    throw new InvalidContractInputError("post.status must be queued or scheduled at create time");
  }
  requireInstantOrNull(input.post.scheduledAt, "post.scheduledAt");
  if (input.post.platforms.length === 0) {
    throw new InvalidContractInputError("post.platforms must not be empty");
  }

  if (input.publications.length === 0) {
    throw new InvalidContractInputError("a create transaction needs at least one publication");
  }
  const publicationIds = new Set<string>();
  const publicationPlatforms = new Set<string>();
  for (const publication of input.publications) {
    if (!isOpaqueId(publication.id) || publicationIds.has(publication.id)) {
      throw new InvalidContractInputError("publication ids must be unique opaque identifiers");
    }
    publicationIds.add(publication.id);
    // One credential slot per platform, so at most one publication per platform.
    if (publicationPlatforms.has(publication.platform)) {
      throw new InvalidContractInputError(
        "each platform may appear in at most one publication per create",
      );
    }
    publicationPlatforms.add(publication.platform);
    if (!input.post.platforms.includes(publication.platform)) {
      throw new InvalidContractInputError("publication platform must be part of post.platforms");
    }
    if (publication.postId !== input.post.id) {
      throw new InvalidContractInputError("every publication must belong to the created post");
    }
    if (publication.status !== "pending" && publication.status !== "scheduled") {
      throw new InvalidContractInputError(
        "publication.status must be pending or scheduled at create time",
      );
    }
    requireInstantOrNull(publication.scheduledAt, "publication.scheduledAt");
    requireRevision(publication.credentialRevision, "publication.credentialRevision");
  }
  for (const platform of input.post.platforms) {
    if (!publicationPlatforms.has(platform)) {
      throw new InvalidContractInputError("every requested platform needs exactly one publication");
    }
  }

  if (input.jobs.length !== input.publications.length) {
    throw new InvalidContractInputError("each publication needs exactly one initial job");
  }
  const jobIds = new Set<string>();
  const jobAggregates = new Set<string>();
  for (const job of input.jobs) {
    if (!isOpaqueId(job.id) || jobIds.has(job.id)) {
      throw new InvalidContractInputError("job ids must be unique opaque identifiers");
    }
    jobIds.add(job.id);
    if (jobAggregates.has(job.aggregateId)) {
      throw new InvalidContractInputError("a publication cannot have two initial jobs");
    }
    jobAggregates.add(job.aggregateId);
    if (job.kind !== "delivery.execute") {
      throw new InvalidContractInputError("initial jobs must be delivery.execute");
    }
    if (job.attemptNo !== 1) {
      throw new InvalidContractInputError("initial jobs must be attempt 1");
    }
    if (!publicationIds.has(job.aggregateId)) {
      throw new InvalidContractInputError("job aggregateId must reference a created publication");
    }
    if (!isIsoInstant(job.availableAt)) {
      throw new InvalidContractInputError("job.availableAt must be a canonical UTC instant");
    }
  }
  for (const publicationId of publicationIds) {
    if (!jobAggregates.has(publicationId)) {
      throw new InvalidContractInputError("every publication needs its own initial job");
    }
  }

  const guardedPlatforms = new Set<string>();
  const guardByPlatform = new Map<string, CredentialGuard>();
  for (const guard of input.credentialGuards) {
    if (guardedPlatforms.has(guard.platform)) {
      throw new InvalidContractInputError("credential guards must be unique per platform");
    }
    guardedPlatforms.add(guard.platform);
    guardByPlatform.set(guard.platform, guard);
    requireRevision(guard.expectedRevision, "credentialGuard.expectedRevision");
  }
  for (const platform of publicationPlatforms) {
    if (!guardedPlatforms.has(platform)) {
      throw new InvalidContractInputError("every targeted platform needs a credential guard");
    }
  }
  for (const platform of guardedPlatforms) {
    if (!publicationPlatforms.has(platform)) {
      throw new InvalidContractInputError("credential guards must not cover untargeted platforms");
    }
  }
  // The publication's recorded creation revision and the guard the caller
  // verified come from the same credential read, so a mismatch means the DTO
  // drifted. Execution claims use the preparation-time revision either way.
  for (const publication of input.publications) {
    const guard = guardByPlatform.get(publication.platform);
    if (guard === undefined) {
      throw new InvalidContractInputError("every publication needs a credential guard");
    }
    if (publication.credentialRevision !== guard.expectedRevision) {
      throw new InvalidContractInputError(
        "publication credentialRevision must match its credential guard",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimCondition {
  readonly jobId: string;
  readonly publicationId: string;
  readonly attemptNo: number;
  readonly now: IsoInstant;
  /**
   * Latest credential slot revision observed during preparation. The claim
   * re-checks that the slot still carries this revision: a later refresh must
   * not permanently lock scheduled work, yet a credential that changed between
   * preparation and claim must still be refused.
   */
  readonly credentialSlotRevision: number;
  readonly claimToken: string;
  readonly attemptId: string;
}

export type ClaimBlockReason =
  | "not_found"
  | "not_current_job"
  | "entity_mismatch"
  | "kind_mismatch"
  | "attempt_mismatch"
  | "not_due"
  | "terminal"
  | "publication_state"
  | "cancelled_job"
  | "already_claimed"
  | "attempt_budget_exhausted"
  | "credential_revision_mismatch"
  | "dlq_seen";

export type ClaimResult =
  | { readonly kind: "claimed"; readonly execution: ExecutionSnapshot }
  | { readonly kind: "not_claimed"; readonly reason: ClaimBlockReason }
  /** The claim write result is unknown: the caller must not call the provider. */
  | { readonly kind: "unknown" };

// ---------------------------------------------------------------------------
// Outcome commit
// ---------------------------------------------------------------------------

export interface ExecutionCommitBase {
  readonly jobId: string;
  readonly publicationId: string;
  readonly attemptId: string;
  readonly claimToken: string;
  readonly now: IsoInstant;
}

export type ExecutionCommit =
  | (ExecutionCommitBase & {
      readonly outcome: "published";
      readonly externalId: string | null;
      readonly externalUrl: string | null;
      readonly archive: PlannedArchive | null;
    })
  | (ExecutionCommitBase & {
      readonly outcome: "failed";
      readonly terminalReason: TerminalReason;
      readonly errorCode: PublishErrorCode | null;
      readonly errorAmbiguous: boolean;
      readonly archive: PlannedArchive | null;
    })
  | (ExecutionCommitBase & {
      readonly outcome: "safe_retry";
      readonly errorCode: PublishErrorCode | null;
      readonly retryAt: IsoInstant;
      /** Pre-generated identity of the future job; committed atomically. */
      readonly nextJob: NewOutboxJobRecord;
      readonly archive: PlannedArchive | null;
    });

/**
 * Deterministic identity of a commit for replay detection. A repeated commit
 * for the same attempt with the same fingerprint is `already_applied`; a
 * different fingerprint for an attempt that already committed is a conflict.
 */
export function executionCommitFingerprint(commit: ExecutionCommit): string {
  switch (commit.outcome) {
    case "published":
      return JSON.stringify([
        "published",
        commit.externalId,
        commit.externalUrl,
        commit.archive?.key ?? null,
      ]);
    case "failed":
      return JSON.stringify([
        "failed",
        commit.terminalReason,
        commit.errorCode,
        commit.errorAmbiguous,
        commit.archive?.key ?? null,
      ]);
    case "safe_retry":
      return JSON.stringify([
        "safe_retry",
        commit.errorCode,
        commit.retryAt,
        commit.nextJob.id,
        commit.nextJob.attemptNo,
        commit.archive?.key ?? null,
      ]);
  }
}

// ---------------------------------------------------------------------------
// Pre-execution rejection and DLQ settlement
// ---------------------------------------------------------------------------

/**
 * Permanent local failure detected before any provider call (config or
 * binding). Records a terminal, non-ambiguous result and cancels the unsent
 * transport intent; attempts are not charged.
 */
export interface PreExecutionRejection {
  readonly jobId: string;
  readonly publicationId: string;
  readonly now: IsoInstant;
  readonly terminalReason: TerminalReason;
  readonly errorCode: PublishErrorCode | null;
}

export interface DeadLetterCondition {
  readonly jobId: string;
  readonly publicationId: string;
  readonly now: IsoInstant;
  readonly transportReason: TransportReason;
}

export type ArchiveResultStatus = "available" | "failed" | "unavailable";

/**
 * Result of the best-effort archive write that follows a committed provider
 * outcome. Applies only to the publication's current attempt and planned
 * logical key, so a late result can never attach itself to a newer attempt.
 */
export interface ArchiveResultCommit {
  readonly publicationId: string;
  readonly attemptId: string;
  readonly archiveKey: string;
  readonly status: ArchiveResultStatus;
  readonly now: IsoInstant;
}

export type DeadLetterOutcome =
  | { readonly kind: "dead_lettered"; readonly attempts: number }
  /** A stale claim was recovered conservatively as unknown. */
  | { readonly kind: "recovered_unknown"; readonly attempts: number }
  | {
      readonly kind: "recorded";
      readonly reason: "terminal" | "not_current_job" | "active_claim" | "not_due";
    }
  | { readonly kind: "not_found" };
