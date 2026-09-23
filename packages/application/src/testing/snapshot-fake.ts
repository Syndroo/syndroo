/**
 * Rollback-capable in-memory fake for every application port.
 *
 * Every write runs inside a staged transaction: the candidate state is built
 * in a private copy and only swapped in when the whole logical operation
 * succeeds. A thrown fault, a zero-row guard or a conflicting replay therefore
 * leaves the previous snapshot byte-identical, which is exactly the property
 * the D1 adapter must reproduce (SQL rollback plus zero-row guards).
 *
 * All port methods do their read-modify-write work synchronously, so
 * concurrent callers serialize instead of interleaving: two claims of the same
 * job cannot both win.
 */

import type { Platform, PostStatus, PublicationStatus } from "@syndroo/core";

import type {
  ActivationCommit,
  ActivationResult,
  AuthOperationStart,
  CandidateCommit,
  EncryptedCredential,
  EncryptedSlotSnapshot,
  OAuthClaim,
  OAuthClaimResult,
  RefreshClaim,
  RefreshClaimResult,
  RefreshCommit,
  RefreshFailure,
  RefreshLease,
  SlotMutation,
  SlotMutationResult,
  StoredAuthOperation,
} from "../contracts/credentials.js";
import { refreshCommitFingerprint } from "../contracts/credentials.js";
import type { SafeTarget } from "../contracts/status.js";
import {
  executionCommitFingerprint,
  validateCreatePostTransaction,
  type ClaimCondition,
  type ClaimResult,
  type CommittedOutcomeIdentity,
  type ArchiveResultCommit,
  type CreateCommitResult,
  type CreatePostTransaction,
  type DeadLetterCondition,
  type DeadLetterOutcome,
  type ExecutionCommit,
  type ExecutionSnapshot,
  type IdempotentPostRecord,
  type PostSnapshot,
  type PreExecutionRejection,
  type PublicationSnapshot,
  type PublicationSummary,
} from "../contracts/execution.js";
import {
  decodeQueueEnvelopeV1,
  type DispatchObservation,
  type OutboxJob,
  type QueueEnvelopeV1,
  type ReadyQuery,
  type RearmCondition,
  type RearmResult,
} from "../contracts/outbox.js";
import {
  COMMIT_ALREADY_APPLIED,
  COMMIT_APPLIED,
  CorruptStoreRecordError,
  InvalidContractInputError,
  MAX_STALLED_RECOVERIES,
  OUTBOX_FINISHED_RETENTION_MS,
  PUBLISHER_MAX_ATTEMPTS,
  STALE_CLAIM_WINDOW_MS,
  STALLED_RECOVERY_MIN_WAIT_MS,
  commitConflict,
  compareInstants,
  isDueAt,
  requireMaintenanceBudget,
  requireOpaqueId,
  type CleanupResult,
  type CommitResult,
  type IsoInstant,
  type MaintenanceBudget,
  type RecoveryResult,
} from "../contracts/primitives.js";
import {
  archiveExpired,
  assertSanitizedArchive,
  isSafeArchiveKey,
  isSafeBlobKey,
  type ArchiveKey,
  type BlobKey,
  type BlobMetadata,
  type BlobRead,
  type SafeDiagnostics,
  type SafeLogEvent,
  type SanitizedArchive,
  type StoredBlob,
} from "../contracts/storage.js";
import type { ArchiveStore } from "../ports/archive-store.js";
import type { BlobStore } from "../ports/blob-store.js";
import type { CredentialCipher } from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { DiagnosticsReader } from "../ports/diagnostics-reader.js";
import { JobQueueError, type JobQueue } from "../ports/job-queue.js";
import type { Logger } from "../ports/logger.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import type { PublishingStore } from "../ports/publishing-store.js";
import { createTestCipher } from "./fake-cipher.js";
import { FIXTURE_NOW } from "./fixtures.js";

const TERMINAL_PUBLICATION_STATUSES: readonly PublicationStatus[] = ["published", "failed"];

const MAX_STREAM_BYTES = 8 * 1024 * 1024;

interface FakePostRow {
  readonly post: PostSnapshot;
}

interface FakePublicationRow {
  readonly publication: PublicationSnapshot;
}

interface FakeCreateRow {
  readonly scope: "posts.create.v1";
  readonly key: string | null;
  readonly requestFingerprint: string;
  readonly postId: string;
  readonly publicationIds: readonly string[];
  readonly jobIds: readonly string[];
  readonly createdAt: IsoInstant;
}

interface FakeState {
  readonly posts: Map<string, FakePostRow>;
  readonly publications: Map<string, FakePublicationRow>;
  readonly jobs: Map<string, OutboxJob>;
  readonly createRecords: Map<string, FakeCreateRow>;
  readonly createIndex: Map<string, string>;
  readonly slots: Map<Platform, EncryptedSlotSnapshot>;
  readonly operations: Map<string, StoredAuthOperation>;
  readonly archives: Map<ArchiveKey, SanitizedArchive>;
  readonly blobs: Map<BlobKey, BlobRead>;
}

function emptyState(): FakeState {
  return {
    posts: new Map(),
    publications: new Map(),
    jobs: new Map(),
    createRecords: new Map(),
    createIndex: new Map(),
    slots: new Map(),
    operations: new Map(),
    archives: new Map(),
    blobs: new Map(),
  };
}

function cloneState(state: FakeState): FakeState {
  return {
    posts: new Map(state.posts),
    publications: new Map(state.publications),
    jobs: new Map(state.jobs),
    createRecords: new Map(state.createRecords),
    createIndex: new Map(state.createIndex),
    slots: new Map(state.slots),
    operations: new Map(state.operations),
    archives: new Map(state.archives),
    blobs: new Map(state.blobs),
  };
}

export interface FakeFaultInjection {
  /** Throws after the transaction has staged its writes, proving rollback. */
  readonly failNextCreateAfterStage?: Error;
  readonly failNextCommitAfterStage?: Error;
  readonly failNextRejectionAfterStage?: Error;
  readonly failNextDeadLetterRecordAfterStage?: Error;
  readonly failNextDispatchRecordAfterStage?: Error;
  readonly failNextSlotMutationAfterStage?: Error;
  readonly failNextActivationAfterStage?: Error;
  readonly failNextRefreshCommitAfterStage?: Error;
  readonly claimResultUnknownOnce?: boolean;
  /** The claim commits, then the caller loses the result. */
  readonly claimCommittedUnknownOnce?: boolean;
  readonly refreshClaimResultUnknownOnce?: boolean;
  /** The lease commits, then the caller loses the result. */
  readonly refreshClaimCommittedUnknownOnce?: boolean;
  readonly oauthClaimResultUnknownOnce?: boolean;
  /** The callback claim commits, then the caller loses the result. */
  readonly oauthClaimCommittedUnknownOnce?: boolean;
  readonly failNextQueueSend?: Error;
}

export interface FakeFaultController {
  inject(injection: FakeFaultInjection): void;
  clear(): void;
  readonly pending: ReadonlySet<string>;
}

export interface SnapshotFakeClock {
  now(): IsoInstant;
  set(instant: IsoInstant): void;
}

export interface FakeSnapshot {
  readonly posts: readonly PostSnapshot[];
  readonly publications: readonly PublicationSnapshot[];
  readonly jobs: readonly OutboxJob[];
  readonly createRecords: readonly IdempotentPostRecord[];
  readonly slots: readonly EncryptedSlotSnapshot[];
  readonly operations: readonly StoredAuthOperation[];
  readonly archives: readonly ArchiveKey[];
  readonly blobKeys: readonly BlobKey[];
  readonly sentEnvelopes: readonly QueueEnvelopeV1[];
}

export interface SnapshotFake {
  readonly publishing: PublishingStore;
  readonly outbox: OutboxStore;
  readonly credentials: CredentialStore;
  readonly queue: JobQueue;
  readonly archive: ArchiveStore;
  readonly blobs: BlobStore;
  readonly cipher: CredentialCipher;
  readonly logger: Logger;
  readonly diagnostics: DiagnosticsReader;
  readonly faults: FakeFaultController;
  readonly clock: SnapshotFakeClock;
  readonly sentEnvelopes: readonly QueueEnvelopeV1[];
  readonly logEvents: readonly SafeLogEvent[];
  snapshot(): FakeSnapshot;
  reset(): void;
  /** Test-only fixture: attach residual secrets to an existing operation. */
  placeResidualSecrets(input: {
    readonly operationId: string;
    readonly requestSecret: EncryptedCredential;
    readonly candidateSecret: EncryptedCredential;
    readonly now: IsoInstant;
  }): void;
}

export interface SnapshotFakeOptions {
  readonly now?: IsoInstant;
  readonly cipher?: CredentialCipher;
}

export function createSnapshotFake(options: SnapshotFakeOptions = {}): SnapshotFake {
  let state = emptyState();
  let currentNow: IsoInstant = options.now ?? FIXTURE_NOW;
  const sentEnvelopes: QueueEnvelopeV1[] = [];
  const logEvents: SafeLogEvent[] = [];
  const pendingFaults = new Map<string, unknown>();

  const faults: FakeFaultController = {
    inject(injection: FakeFaultInjection): void {
      for (const [key, value] of Object.entries(injection)) {
        if (value === undefined || value === false) {
          pendingFaults.delete(key);
          continue;
        }
        pendingFaults.set(key, value);
      }
    },
    clear(): void {
      pendingFaults.clear();
    },
    get pending(): ReadonlySet<string> {
      return new Set(pendingFaults.keys());
    },
  };

  const clock: SnapshotFakeClock = {
    now: () => currentNow,
    set: (instant: IsoInstant) => {
      currentNow = instant;
    },
  };

  function consumeFault(key: string): void {
    if (!pendingFaults.has(key)) {
      return;
    }
    const fault = pendingFaults.get(key);
    pendingFaults.delete(key);
    if (fault instanceof Error) {
      throw fault;
    }
    throw new Error(`injected fault: ${key}`);
  }

  function consumeFlag(key: string): boolean {
    if (pendingFaults.get(key) !== true) {
      return false;
    }
    pendingFaults.delete(key);
    return true;
  }

  function transact<T>(mutate: (draft: FakeState) => T): T {
    const draft = cloneState(state);
    const result = mutate(draft);
    state = draft;
    return result;
  }

  function publicationsOf(draft: FakeState, postId: string): readonly PublicationSnapshot[] {
    return [...draft.publications.values()]
      .map((row) => row.publication)
      .filter((publication) => publication.postId === postId);
  }

  function updatePostAggregate(draft: FakeState, postId: string, now: IsoInstant): void {
    const row = draft.posts.get(postId);
    if (row === undefined) {
      throw new CorruptStoreRecordError("publication references a missing post");
    }
    const status = aggregatePostStatus(publicationsOf(draft, postId), row.post.scheduledAt);
    draft.posts.set(postId, {
      post: freezePost({ ...row.post, status, updatedAt: now }),
    });
  }

  function cancelJob(draft: FakeState, jobId: string, now: IsoInstant): void {
    const job = draft.jobs.get(jobId);
    if (job === undefined) {
      return;
    }
    draft.jobs.set(jobId, freezeJob({ ...job, status: "cancelled", updatedAt: now }));
  }

  function projectCreateRecord(
    draft: FakeState,
    row: FakeCreateRow,
  ): IdempotentPostRecord | null {
    const post = draft.posts.get(row.postId)?.post;
    if (post === undefined) {
      return null;
    }
    const publications: PublicationSummary[] = [];
    for (const publicationId of row.publicationIds) {
      const publication = draft.publications.get(publicationId)?.publication;
      if (publication === undefined) {
        return null;
      }
      publications.push(toSummary(publication));
    }
    return Object.freeze({
      scope: row.scope,
      key: row.key,
      requestFingerprint: row.requestFingerprint,
      post,
      publications: Object.freeze(publications),
      jobIds: Object.freeze([...row.jobIds]),
      createdAt: row.createdAt,
    });
  }

  const publishing: PublishingStore = {
    async findIdempotentPost(input) {
      if (input.scope !== "posts.create.v1") {
        throw new InvalidContractInputError("unsupported idempotency scope");
      }
      if (input.key === null) {
        return null;
      }
      const postId = state.createIndex.get(`${input.scope}:${input.key}`);
      if (postId === undefined) {
        return null;
      }
      const row = state.createRecords.get(postId);
      if (row === undefined) {
        throw new CorruptStoreRecordError("idempotency index points to a missing post");
      }
      const record = projectCreateRecord(state, row);
      if (record === null) {
        throw new CorruptStoreRecordError("idempotency record is incomplete");
      }
      return record;
    },

    async createPostWithDispatch(input) {
      validateCreatePostTransaction(input);
      const indexKey =
        input.idempotencyKey === null ? null : `${input.scope}:${input.idempotencyKey}`;
      return transact((draft) => {
        if (indexKey !== null) {
          const existingPostId = draft.createIndex.get(indexKey);
          if (existingPostId !== undefined) {
            const existingRow = draft.createRecords.get(existingPostId);
            if (existingRow === undefined) {
              throw new CorruptStoreRecordError("idempotency index points to a missing post");
            }
            const existingRecord = projectCreateRecord(draft, existingRow);
            if (existingRecord === null) {
              throw new CorruptStoreRecordError("idempotency record is incomplete");
            }
            // Same key: hand the original record back so the application applies
            // the canonical request comparison and decides 200 replay vs 409.
            return { kind: "replayed", record: existingRecord } as CreateCommitResult;
          }
        }

        for (const guard of input.credentialGuards) {
          const slot = draft.slots.get(guard.platform);
          const revision = slot?.revision ?? 0;
          if (revision !== guard.expectedRevision) {
            return commitCreateConflict("credential_revision_mismatch");
          }
          if (
            guard.bindingId !== null &&
            slot !== undefined &&
            slot.bindingId !== null &&
            slot.bindingId !== guard.bindingId
          ) {
            return commitCreateConflict("credential_revision_mismatch");
          }
        }

        if (draft.posts.has(input.post.id)) {
          return commitCreateConflict("duplicate_publication");
        }
        for (const publication of input.publications) {
          if (draft.publications.has(publication.id)) {
            return commitCreateConflict("duplicate_publication");
          }
        }
        for (const job of input.jobs) {
          if (draft.jobs.has(job.id)) {
            return commitCreateConflict("duplicate_job");
          }
        }

        draft.posts.set(input.post.id, { post: makePostSnapshot(input) });
        const jobIdByPublication = new Map<string, string>();
        for (const job of input.jobs) {
          jobIdByPublication.set(job.aggregateId, job.id);
        }
        for (const publication of input.publications) {
          draft.publications.set(publication.id, {
            publication: makePublicationSnapshot(
              publication,
              input.now,
              jobIdByPublication.get(publication.id) ?? null,
            ),
          });
        }
        for (const job of input.jobs) {
          draft.jobs.set(job.id, makeJob(job, input.now));
        }
        const row: FakeCreateRow = {
          scope: "posts.create.v1",
          key: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          postId: input.post.id,
          publicationIds: input.publications.map((publication) => publication.id),
          jobIds: input.jobs.map((job) => job.id),
          createdAt: input.now,
        };
        draft.createRecords.set(input.post.id, row);
        if (indexKey !== null) {
          draft.createIndex.set(indexKey, input.post.id);
        }

        consumeFault("failNextCreateAfterStage");

        const record = projectCreateRecord(draft, row);
        if (record === null) {
          throw new CorruptStoreRecordError("created record is incomplete");
        }
        return { kind: "created", record } as CreateCommitResult;
      });
    },

    async getExecution(input) {
      const publication = state.publications.get(input.publicationId)?.publication;
      const job = state.jobs.get(input.jobId);
      if (publication === undefined || job === undefined) {
        return null;
      }
      if (job.aggregateId !== input.publicationId) {
        return null;
      }
      const post = state.posts.get(publication.postId)?.post;
      if (post === undefined) {
        throw new CorruptStoreRecordError("publication references a missing post");
      }
      return freezeExecution({ publication, post, job });
    },

    async claimExecution(input) {
      requireOpaqueId(input.claimToken, "claimToken");
      requireOpaqueId(input.attemptId, "attemptId");
      return transact((draft) => {
        const publicationRow = draft.publications.get(input.publicationId);
        const job = draft.jobs.get(input.jobId);
        if (publicationRow === undefined || job === undefined) {
          return { kind: "not_claimed", reason: "not_found" } as ClaimResult;
        }
        const publication = publicationRow.publication;
        if (job.kind !== "delivery.execute") {
          return { kind: "not_claimed", reason: "kind_mismatch" } as ClaimResult;
        }
        if (job.aggregateId !== input.publicationId) {
          return { kind: "not_claimed", reason: "entity_mismatch" } as ClaimResult;
        }
        if (job.attemptNo !== input.attemptNo) {
          return { kind: "not_claimed", reason: "attempt_mismatch" } as ClaimResult;
        }
        if (job.status === "cancelled") {
          // Transport intent is finished: a superseded job never executes.
          return { kind: "not_claimed", reason: "cancelled_job" } as ClaimResult;
        }
        if (job.dlqSeenAt !== null) {
          return { kind: "not_claimed", reason: "dlq_seen" } as ClaimResult;
        }
        if (publication.currentJobId !== input.jobId) {
          return { kind: "not_claimed", reason: "not_current_job" } as ClaimResult;
        }
        if (isTerminalPublication(publication.status)) {
          return { kind: "not_claimed", reason: "terminal" } as ClaimResult;
        }
        if (publication.claimToken !== null) {
          return { kind: "not_claimed", reason: "already_claimed" } as ClaimResult;
        }
        if (publication.status !== "pending" && publication.status !== "scheduled") {
          return { kind: "not_claimed", reason: "publication_state" } as ClaimResult;
        }
        if (input.attemptNo !== publication.attempts + 1) {
          return { kind: "not_claimed", reason: "attempt_mismatch" } as ClaimResult;
        }
        if (!isDueAt(job.availableAt, input.now)) {
          return { kind: "not_claimed", reason: "not_due" } as ClaimResult;
        }
        if (publication.attempts >= PUBLISHER_MAX_ATTEMPTS) {
          return { kind: "not_claimed", reason: "attempt_budget_exhausted" } as ClaimResult;
        }
        const slotRevision = draft.slots.get(publication.platform)?.revision ?? 0;
        if (slotRevision !== input.credentialSlotRevision) {
          return { kind: "not_claimed", reason: "credential_revision_mismatch" } as ClaimResult;
        }
        if (consumeFlag("claimResultUnknownOnce")) {
          return { kind: "unknown" } as ClaimResult;
        }

        const claimed = freezePublication({
          ...publication,
          status: "publishing",
          attempts: publication.attempts + 1,
          claimToken: input.claimToken,
          attemptId: input.attemptId,
          currentJobId: input.jobId,
          publishingAt: input.now,
          // A new attempt has no archive plan of its own yet, so the previous
          // attempt's archive state is never attributed to it.
          archiveKey: null,
          archiveStatus: "not_requested",
          updatedAt: input.now,
        });
        draft.publications.set(publication.id, { publication: claimed });
        updatePostAggregate(draft, publication.postId, input.now);
        if (consumeFlag("claimCommittedUnknownOnce")) {
          // The write committed; only the caller's view of the result was lost.
          return { kind: "unknown" } as ClaimResult;
        }
        const post = draft.posts.get(publication.postId)?.post;
        if (post === undefined) {
          throw new CorruptStoreRecordError("publication references a missing post");
        }
        return {
          kind: "claimed",
          execution: freezeExecution({ publication: claimed, post, job }),
        } as ClaimResult;
      });
    },

    async commitExecution(input: ExecutionCommit) {
      return transact((draft) => {
        const publicationRow = draft.publications.get(input.publicationId);
        const job = draft.jobs.get(input.jobId);
        if (publicationRow === undefined || job === undefined) {
          return commitConflict("not_found");
        }
        const publication = publicationRow.publication;
        const fingerprint = executionCommitFingerprint(input);
        const committed = publication.committedOutcome;
        if (committed !== null && committed.key === input.attemptId) {
          return committed.fingerprint === fingerprint
            ? COMMIT_ALREADY_APPLIED
            : commitConflict("guard_mismatch");
        }
        if (
          publication.status !== "publishing" ||
          publication.claimToken !== input.claimToken ||
          publication.currentJobId !== input.jobId ||
          publication.attemptId !== input.attemptId
        ) {
          return commitConflict(
            isTerminalPublication(publication.status) ? "terminal" : "guard_mismatch",
          );
        }

        if (input.outcome === "safe_retry") {
          if (publication.attempts >= PUBLISHER_MAX_ATTEMPTS) {
            return commitConflict("attempt_budget_exhausted");
          }
          if (input.nextJob.kind !== "delivery.execute") {
            return commitConflict("guard_mismatch");
          }
          if (input.nextJob.aggregateId !== publication.id) {
            return commitConflict("guard_mismatch");
          }
          if (input.nextJob.attemptNo !== publication.attempts + 1) {
            return commitConflict("duplicate_attempt");
          }
          if (input.nextJob.availableAt !== input.retryAt) {
            return commitConflict("guard_mismatch");
          }
          if (draft.jobs.has(input.nextJob.id)) {
            return commitConflict("guard_mismatch");
          }
        }

        const archiveFields =
          input.archive === null
            ? { archiveKey: null, archiveStatus: "not_requested" as const }
            : { archiveKey: input.archive.key, archiveStatus: "pending" as const };

        const next: PublicationSnapshot =
          input.outcome === "published"
            ? freezePublication({
                ...publication,
                status: "published",
                publishedAt: input.now,
                externalId: input.externalId,
                externalUrl: input.externalUrl,
                errorCode: null,
                errorAmbiguous: false,
                terminalReason: null,
                claimToken: null,
                retryAt: null,
                committedOutcome: freezeCommittedOutcome(input.attemptId, fingerprint),
                updatedAt: input.now,
                ...archiveFields,
              })
            : input.outcome === "failed"
              ? freezePublication({
                  ...publication,
                  status: "failed",
                  terminalReason: input.terminalReason,
                  errorCode: input.errorCode,
                  errorAmbiguous: input.errorAmbiguous,
                  claimToken: null,
                  retryAt: null,
                  committedOutcome: freezeCommittedOutcome(input.attemptId, fingerprint),
                  updatedAt: input.now,
                  ...archiveFields,
                })
              : freezePublication({
                  ...publication,
                  status: "pending",
                  retryAt: input.retryAt,
                  errorCode: input.errorCode,
                  errorAmbiguous: false,
                  terminalReason: null,
                  claimToken: null,
                  attemptId: null,
                  currentJobId: input.nextJob.id,
                  committedOutcome: freezeCommittedOutcome(input.attemptId, fingerprint),
                  updatedAt: input.now,
                  ...archiveFields,
                });

        draft.publications.set(publication.id, { publication: next });
        cancelJob(draft, job.id, input.now);
        if (input.outcome === "safe_retry") {
          draft.jobs.set(input.nextJob.id, makeJob(input.nextJob, input.now));
        }
        updatePostAggregate(draft, publication.postId, input.now);

        consumeFault("failNextCommitAfterStage");
        return COMMIT_APPLIED;
      });
    },

    async rejectBeforeExecution(input: PreExecutionRejection) {
      return transact((draft) => {
        const publicationRow = draft.publications.get(input.publicationId);
        const job = draft.jobs.get(input.jobId);
        if (publicationRow === undefined || job === undefined) {
          return commitConflict("not_found");
        }
        const publication = publicationRow.publication;
        const fingerprint = JSON.stringify(["rejected", input.terminalReason, input.errorCode]);
        const committed = publication.committedOutcome;
        if (committed !== null && committed.key === input.jobId) {
          return committed.fingerprint === fingerprint
            ? COMMIT_ALREADY_APPLIED
            : commitConflict("guard_mismatch");
        }
        if (isTerminalPublication(publication.status)) {
          return commitConflict("terminal");
        }
        if (publication.claimToken !== null) {
          return commitConflict("already_claimed");
        }
        if (publication.currentJobId !== input.jobId || job.aggregateId !== input.publicationId) {
          return commitConflict("guard_mismatch");
        }
        const next = freezePublication({
          ...publication,
          status: "failed",
          terminalReason: input.terminalReason,
          errorCode: input.errorCode,
          errorAmbiguous: false,
          claimToken: null,
          retryAt: null,
          committedOutcome: freezeCommittedOutcome(input.jobId, fingerprint),
          updatedAt: input.now,
        });
        draft.publications.set(publication.id, { publication: next });
        cancelJob(draft, job.id, input.now);
        updatePostAggregate(draft, publication.postId, input.now);
        consumeFault("failNextRejectionAfterStage");
        return COMMIT_APPLIED;
      });
    },

    async settleDeadLetter(input: DeadLetterCondition) {
      return transact((draft) => {
        const publicationRow = draft.publications.get(input.publicationId);
        const job = draft.jobs.get(input.jobId);
        if (publicationRow === undefined || job === undefined) {
          return { kind: "not_found" } as DeadLetterOutcome;
        }
        const publication = publicationRow.publication;
        if (job.aggregateId !== input.publicationId) {
          // Malformed cross-entity message: never write metadata before the
          // pair is proven, or it would poison another publication's job.
          return { kind: "recorded", reason: "not_current_job" } as DeadLetterOutcome;
        }
        draft.jobs.set(
          job.id,
          freezeJob({
            ...job,
            dlqSeenAt: input.now,
            transportReason: input.transportReason,
            updatedAt: input.now,
          }),
        );
        consumeFault("failNextDeadLetterRecordAfterStage");

        if (isTerminalPublication(publication.status)) {
          return { kind: "recorded", reason: "terminal" } as DeadLetterOutcome;
        }
        if (publication.currentJobId !== input.jobId) {
          return { kind: "recorded", reason: "not_current_job" } as DeadLetterOutcome;
        }
        if (publication.status === "publishing") {
          const claimAgeMs =
            publication.publishingAt === null
              ? Number.POSITIVE_INFINITY
              : Date.parse(input.now) - Date.parse(publication.publishingAt);
          if (claimAgeMs < STALE_CLAIM_WINDOW_MS) {
            return { kind: "recorded", reason: "active_claim" } as DeadLetterOutcome;
          }
          const next = freezePublication({
            ...publication,
            status: "failed",
            errorAmbiguous: true,
            terminalReason: "unknown",
            claimToken: null,
            updatedAt: input.now,
          });
          draft.publications.set(publication.id, { publication: next });
          cancelJob(draft, job.id, input.now);
          updatePostAggregate(draft, publication.postId, input.now);
          return { kind: "recovered_unknown", attempts: publication.attempts } as DeadLetterOutcome;
        }
        if (publication.claimToken !== null) {
          return { kind: "recorded", reason: "active_claim" } as DeadLetterOutcome;
        }
        if (!isDueAt(job.availableAt, input.now)) {
          // Future current job: transport failure is visible, the scheduled
          // transition is preserved, and maintenance settles it at due time.
          return { kind: "recorded", reason: "not_due" } as DeadLetterOutcome;
        }
        const next = freezePublication({
          ...publication,
          status: "failed",
          errorAmbiguous: false,
          terminalReason: "dead_lettered",
          claimToken: null,
          updatedAt: input.now,
        });
        draft.publications.set(publication.id, { publication: next });
        cancelJob(draft, job.id, input.now);
        updatePostAggregate(draft, publication.postId, input.now);
        return { kind: "dead_lettered", attempts: publication.attempts } as DeadLetterOutcome;
      });
    },

    async recordArchiveResult(input: ArchiveResultCommit) {
      return transact((draft) => {
        const publicationRow = draft.publications.get(input.publicationId);
        if (publicationRow === undefined) {
          return commitConflict("not_found");
        }
        const publication = publicationRow.publication;
        // Identity of the attempt whose archive is being reported. A live
        // attempt id wins; once a terminal commit cleared it (for example a
        // safe retry), the committed outcome key still names that attempt, so
        // the result can land before the next claim.
        const currentAttemptId =
          publication.attemptId ?? publication.committedOutcome?.key ?? null;
        // Only the latest attempt and its planned logical key may be updated: a
        // late archive result must never mark a newer attempt.
        if (currentAttemptId !== input.attemptId || publication.archiveKey !== input.archiveKey) {
          return commitConflict("guard_mismatch");
        }
        if (publication.archiveStatus === input.status) {
          return COMMIT_ALREADY_APPLIED;
        }
        draft.publications.set(publication.id, {
          publication: freezePublication({
            ...publication,
            archiveStatus: input.status,
            updatedAt: input.now,
          }),
        });
        return COMMIT_APPLIED;
      });
    },

    async recoverStaleClaims(input: MaintenanceBudget) {
      requireMaintenanceBudget(input);
      return transact((draft) => {
        let examined = 0;
        let staleClaimsMarkedUnknown = 0;
        let jobsRearmed = 0;
        let jobsDeadLettered = 0;
        let skipped = 0;
        const budgetLeft = (): boolean => examined < input.limit;

        // Eligible candidates are selected before the budget is applied, so a
        // run of ineligible low-id rows can never starve the work that is
        // actually actionable in this tick.
        const staleCandidates = sortedPublications(draft).filter(
          (publication) =>
            publication.status === "publishing" &&
            publication.publishingAt !== null &&
            Date.parse(input.now) - Date.parse(publication.publishingAt) >=
              STALE_CLAIM_WINDOW_MS,
        );
        for (const publication of staleCandidates) {
          if (!budgetLeft()) break;
          examined += 1;
          draft.publications.set(
            publication.id,
            {
              publication: freezePublication({
                ...publication,
                status: "failed",
                errorAmbiguous: true,
                terminalReason: "unknown",
                claimToken: null,
                updatedAt: input.now,
              }),
            },
          );
          if (publication.currentJobId !== null) {
            cancelJob(draft, publication.currentJobId, input.now);
          }
          updatePostAggregate(draft, publication.postId, input.now);
          staleClaimsMarkedUnknown += 1;
        }

        // A DLQ seen while a job is still future must settle at its due time.
        // Early-queued messages are normally `dispatched`, so both transport
        // states are eligible; only the due guard decides the outcome.
        const dlqCandidates = sortedJobs(draft).filter((job) => {
          if (job.dlqSeenAt === null) {
            return false;
          }
          if (job.status !== "pending" && job.status !== "dispatched") {
            return false;
          }
          const publication = draft.publications.get(job.aggregateId)?.publication;
          return (
            publication !== undefined &&
            publication.currentJobId === job.id &&
            !isTerminalPublication(publication.status)
          );
        });
        for (const job of dlqCandidates) {
          if (!budgetLeft()) break;
          const publication = draft.publications.get(job.aggregateId)?.publication;
          if (publication === undefined) {
            continue;
          }
          examined += 1;
          if (!isDueAt(job.availableAt, input.now) || publication.claimToken !== null) {
            skipped += 1;
            continue;
          }
          draft.publications.set(
            publication.id,
            {
              publication: freezePublication({
                ...publication,
                status: "failed",
                errorAmbiguous: false,
                terminalReason: "dead_lettered",
                claimToken: null,
                updatedAt: input.now,
              }),
            },
          );
          cancelJob(draft, job.id, input.now);
          updatePostAggregate(draft, publication.postId, input.now);
          jobsDeadLettered += 1;
        }

        const stalledCandidates = sortedJobs(draft).filter((job) => {
          if (job.status !== "dispatched" || job.dlqSeenAt !== null) {
            return false;
          }
          if (job.recoveryAfter === null || !isDueAt(job.recoveryAfter, input.now)) {
            return false;
          }
          const publication = draft.publications.get(job.aggregateId)?.publication;
          return (
            publication !== undefined &&
            publication.currentJobId === job.id &&
            publication.claimToken === null &&
            !isTerminalPublication(publication.status)
          );
        });
        for (const job of stalledCandidates) {
          if (!budgetLeft()) break;
          const publication = draft.publications.get(job.aggregateId)?.publication;
          if (publication === undefined) {
            continue;
          }
          examined += 1;
          if (job.recoveryCount >= MAX_STALLED_RECOVERIES) {
            draft.publications.set(
              publication.id,
              {
                publication: freezePublication({
                  ...publication,
                  status: "failed",
                  errorAmbiguous: false,
                  terminalReason: "dead_lettered",
                  claimToken: null,
                  updatedAt: input.now,
                }),
              },
            );
            draft.jobs.set(
              job.id,
              freezeJob({
                ...job,
                status: "cancelled",
                transportReason: "stalled_recovery_exhausted",
                updatedAt: input.now,
              }),
            );
            updatePostAggregate(draft, publication.postId, input.now);
            jobsDeadLettered += 1;
            continue;
          }
          draft.jobs.set(
            job.id,
            freezeJob({
              ...job,
              status: "pending",
              dispatchRevision: job.dispatchRevision + 1,
              recoveryCount: job.recoveryCount + 1,
              recoveryAfter: instantAfter(input.now, STALLED_RECOVERY_MIN_WAIT_MS),
              updatedAt: input.now,
            }),
          );
          jobsRearmed += 1;
        }

        return {
          examined,
          staleClaimsMarkedUnknown,
          jobsRearmed,
          jobsDeadLettered,
          skipped,
        } as RecoveryResult;
      });
    },
  };

  const outbox: OutboxStore = {
    async listReady(input: ReadyQuery) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new InvalidContractInputError("ReadyQuery.limit must be a positive safe integer");
      }
      return sortedKeys(state.jobs)
        .map((jobId) => state.jobs.get(jobId))
        .filter((job): job is OutboxJob => job !== undefined)
        .filter(
          (job) =>
            job.status === "pending" &&
            job.dlqSeenAt === null &&
            isDueAt(job.availableAt, input.now),
        )
        .sort((left, right) => {
          const byTime = compareInstants(left.availableAt, right.availableAt);
          return byTime !== 0 ? byTime : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        })
        .slice(0, input.limit);
    },

    async recordDispatch(input: DispatchObservation) {
      return transact((draft) => {
        const job = draft.jobs.get(input.jobId);
        if (job === undefined) {
          return commitConflict("not_found");
        }
        if (job.dlqSeenAt !== null) {
          // A late dispatch mark must not resurrect transport intent that has
          // already failed into the DLQ.
          return commitConflict("guard_mismatch");
        }
        if (job.dispatchRevision !== input.dispatchRevision) {
          return commitConflict("revision_mismatch");
        }
        if (job.status === "cancelled") {
          return commitConflict("terminal");
        }
        if (job.status !== "pending") {
          return commitConflict("guard_mismatch");
        }
        draft.jobs.set(
          job.id,
          input.outcome.kind === "dispatched"
            ? freezeJob({
                ...job,
                status: "dispatched",
                dispatchedAt: input.now,
                recoveryAfter: instantAfter(input.now, STALLED_RECOVERY_MIN_WAIT_MS),
                dispatchAttemptCount: job.dispatchAttemptCount + 1,
                lastDispatchErrorCode: null,
                updatedAt: input.now,
              })
            : freezeJob({
                ...job,
                dispatchAttemptCount: job.dispatchAttemptCount + 1,
                lastDispatchErrorCode: input.outcome.errorCode,
                updatedAt: input.now,
              }),
        );
        consumeFault("failNextDispatchRecordAfterStage");
        return COMMIT_APPLIED;
      });
    },

    async rearmCurrentJob(input: RearmCondition) {
      return transact((draft) => {
        const job = draft.jobs.get(input.jobId);
        if (job === undefined) {
          return { kind: "conflict", reason: "not_found" } as RearmResult;
        }
        const publication = draft.publications.get(input.publicationId)?.publication;
        if (
          publication === undefined ||
          publication.currentJobId !== job.id ||
          job.aggregateId !== input.publicationId
        ) {
          return { kind: "conflict", reason: "not_current_job" } as RearmResult;
        }
        if (isTerminalPublication(publication.status) || job.status === "cancelled") {
          return { kind: "conflict", reason: "terminal" } as RearmResult;
        }
        if (publication.claimToken !== null) {
          return { kind: "conflict", reason: "active_claim" } as RearmResult;
        }
        if (job.dlqSeenAt !== null) {
          return { kind: "conflict", reason: "dlq_seen" } as RearmResult;
        }
        if (input.reason === "stalled_transport") {
          if (job.recoveryAfter === null || !isDueAt(job.recoveryAfter, input.now)) {
            return { kind: "conflict", reason: "not_due" } as RearmResult;
          }
          if (job.recoveryCount >= MAX_STALLED_RECOVERIES) {
            return { kind: "exhausted", recoveryCount: job.recoveryCount } as RearmResult;
          }
        }
        const recoveryCount =
          input.reason === "stalled_transport" ? job.recoveryCount + 1 : job.recoveryCount;
        const next = freezeJob({
          ...job,
          status: "pending",
          dispatchRevision: job.dispatchRevision + 1,
          recoveryCount,
          recoveryAfter:
            input.reason === "stalled_transport"
              ? instantAfter(input.now, STALLED_RECOVERY_MIN_WAIT_MS)
              : job.recoveryAfter,
          updatedAt: input.now,
        });
        draft.jobs.set(job.id, next);
        return {
          kind: "rearmed",
          recoveryCount,
          dispatchRevision: next.dispatchRevision,
        } as RearmResult;
      });
    },

    async collectFinished(input: MaintenanceBudget) {
      requireMaintenanceBudget(input);
      return transact((draft) => {
        // Select the eligible set first, then apply the budget: an ineligible
        // low-id row must not starve collectable work.
        const eligible = sortedJobs(draft)
          .filter((job) => {
            if (job.status !== "cancelled") return false;
            const publication = draft.publications.get(job.aggregateId)?.publication;
            if (publication === undefined || !isTerminalPublication(publication.status)) {
              return false;
            }
            // Unknown/ambiguous results keep their transport record: the
            // diagnostic is part of explaining an uncertain outcome.
            if (
              publication.status === "failed" &&
              (publication.errorAmbiguous || publication.terminalReason === "unknown")
            ) {
              return false;
            }
            return (
              Date.parse(input.now) - Date.parse(job.updatedAt) >= OUTBOX_FINISHED_RETENTION_MS
            );
          })
          .slice(0, input.limit);
        for (const job of eligible) {
          draft.jobs.delete(job.id);
        }
        return { removed: eligible.length } as CleanupResult;
      });
    },
  };

  const credentials: CredentialStore = {
    async readSlot(input) {
      return state.slots.get(input.platform) ?? emptySlot(input.platform);
    },

    async compareAndSetSlot(input: SlotMutation) {
      return transact((draft) => {
        const platform = input.platform;
        const current = draft.slots.get(platform) ?? emptySlot(platform);
        if (current.revision !== input.expectedRevision) {
          return { kind: "conflict", reason: "revision_mismatch" } as SlotMutationResult;
        }
        const change = input.change;
        if (change.kind === "remove") {
          // Every satisfied explicit remove bumps the revision, even when the
          // slot is already a tombstone: an OAuth operation created at the
          // previous revision must not survive a later delete, and a lost
          // response retried with the old revision then conflicts.
          const next = freezeSlot({
            ...emptySlot(platform),
            status: "tombstone",
            revision: current.revision + 1,
            updatedAt: input.now,
          });
          draft.slots.set(platform, next);
          consumeFault("failNextSlotMutationAfterStage");
          return { kind: "applied", revision: next.revision } as SlotMutationResult;
        }
        // A direct set always establishes a new connection: identical
        // ciphertext is not evidence that the binding, target or revision
        // intent is the same, so there is no implicit replay for `set` or
        // `migrate_plaintext`. Callers that need replay carry an explicit
        // operation identity; otherwise a stale CAS conflicts.
        const next = freezeSlot({
          platform,
          status: "active",
          revision: current.revision + 1,
          bindingId: change.bindingId,
          envelope: change.envelope,
          payloadRevision: change.payloadRevision,
          payloadSchemaVersion: change.payloadSchemaVersion,
          expiresAt: change.expiresAt,
          target: change.target,
          refreshLease: null,
          refreshState: "ready",
          lastRefreshCommitFingerprint: null,
          updatedAt: input.now,
        });
        draft.slots.set(platform, next);
        consumeFault("failNextSlotMutationAfterStage");
        return { kind: "applied", revision: next.revision } as SlotMutationResult;
      });
    },

    async createAuthOperation(input: AuthOperationStart) {
      requireOpaqueId(input.operationId, "operationId");
      requireOpaqueId(input.oauthState, "oauthState");
      return transact((draft) => {
        if (draft.operations.has(input.operationId)) {
          throw new InvalidContractInputError("auth operation already exists");
        }
        if (
          [...draft.operations.values()].some(
            (operation) =>
              operation.platform === input.platform && operation.oauthState === input.oauthState,
          )
        ) {
          throw new InvalidContractInputError("oauth state already in use for this platform");
        }
        draft.operations.set(
          input.operationId,
          freezeOperation({
            operationId: input.operationId,
            platform: input.platform,
            phase: "pending_callback",
            expectedRevision: input.expectedRevision,
            canonicalCallbackUrl: input.canonicalCallbackUrl,
            startConfigBinding: input.startConfigBinding,
            oauthState: input.oauthState,
            requestToken: input.requestToken,
            requestSecret: input.requestSecret,
            requestSecretPurpose: input.requestSecretPurpose,
            requestSecretRevision: input.requestSecretRevision,
            candidateEnvelope: null,
            candidatePayloadRevision: null,
            candidatePayloadSchemaVersion: null,
            candidateTarget: null,
            receipt: null,
            missingFields: Object.freeze([]),
            errorCode: null,
            createdAt: input.now,
            updatedAt: input.now,
            expiresAt: input.expiresAt,
          }),
        );
      });
    },

    async findAuthOperationByState(input) {
      for (const operation of state.operations.values()) {
        if (operation.platform === input.platform && operation.oauthState === input.oauthState) {
          return operation;
        }
      }
      return null;
    },

    async claimOAuthCallback(input: OAuthClaim) {
      return transact((draft) => {
        const match = [...draft.operations.values()].find(
          (operation) =>
            operation.platform === input.platform && operation.oauthState === input.oauthState,
        );
        if (match === undefined) {
          return { kind: "conflict", reason: "not_found" } as OAuthClaimResult;
        }
        // Phase first: a completed operation's stored receipt must never be
        // rewritten by a late callback.
        if (match.phase !== "pending_callback") {
          return { kind: "conflict", reason: "phase_mismatch" } as OAuthClaimResult;
        }
        // Conflicts below are read-only: expiry is projected by the caller and
        // the state transition belongs to cleanupExpired.
        if (compareInstants(input.now, match.expiresAt) >= 0) {
          return { kind: "conflict", reason: "expired" } as OAuthClaimResult;
        }
        if (match.startConfigBinding !== input.currentConfigBinding) {
          return { kind: "conflict", reason: "start_config_changed" } as OAuthClaimResult;
        }
        if (match.requestToken !== null && match.requestToken !== input.requestToken) {
          return { kind: "conflict", reason: "request_token_mismatch" } as OAuthClaimResult;
        }
        if (consumeFlag("oauthClaimResultUnknownOnce")) {
          return { kind: "unknown" } as OAuthClaimResult;
        }
        const claimed = freezeOperation({ ...match, phase: "exchanging", updatedAt: input.now });
        draft.operations.set(claimed.operationId, claimed);
        if (consumeFlag("oauthClaimCommittedUnknownOnce")) {
          // The callback claim committed; only the caller's view was lost, so a
          // duplicate must not exchange again.
          return { kind: "unknown" } as OAuthClaimResult;
        }
        return { kind: "claimed", operation: claimed } as OAuthClaimResult;
      });
    },

    async saveCandidate(input: CandidateCommit) {
      return transact((draft) => {
        const operation = draft.operations.get(input.operationId);
        if (operation === undefined) {
          return commitConflict("not_found");
        }
        if (operation.platform !== input.platform || operation.phase !== "exchanging") {
          return commitConflict("phase_mismatch");
        }
        if (compareInstants(input.now, operation.expiresAt) >= 0) {
          // A candidate stored after the TTL would be a usable secret past its
          // lifetime; cleanupExpired performs the state transition instead.
          return commitConflict("operation_expired");
        }
        const cleared = {
          requestSecret: null,
          requestSecretPurpose: null,
          requestSecretRevision: null,
          updatedAt: input.now,
        };
        const next =
          input.outcome.kind === "candidate"
            ? freezeOperation({
                ...operation,
                ...cleared,
                phase: input.outcome.phase,
                candidateEnvelope: input.outcome.candidateEnvelope,
                candidatePayloadRevision: input.outcome.candidatePayloadRevision,
                candidatePayloadSchemaVersion: input.outcome.candidatePayloadSchemaVersion,
                candidateTarget: input.outcome.candidateTarget,
                missingFields: Object.freeze([...input.outcome.missingFields]),
                errorCode: null,
              })
            : freezeOperation({
                ...operation,
                ...cleared,
                phase: "failed",
                errorCode: input.outcome.errorCode,
              });
        draft.operations.set(next.operationId, next);
        return COMMIT_APPLIED;
      });
    },

    async activateCandidate(input: ActivationCommit) {
      return transact((draft) => {
        const operation = draft.operations.get(input.operationId);
        if (operation === undefined) {
          return { kind: "conflict", reason: "not_found" } as ActivationResult;
        }
        if (operation.platform !== input.platform) {
          return { kind: "conflict", reason: "platform_mismatch" } as ActivationResult;
        }
        if (operation.phase === "completed" && operation.receipt !== null) {
          // Replay reports the stored receipt, not whatever the slot became
          // after a later set/remove.
          return {
            kind: "replayed",
            revision: operation.receipt.revision,
            receipt: freezeReceipt({ ...operation.receipt, replayed: true }),
          } as ActivationResult;
        }
        if (
          operation.phase !== "awaiting_confirmation" &&
          operation.phase !== "needs_configuration"
        ) {
          return { kind: "conflict", reason: "phase_mismatch" } as ActivationResult;
        }
        if (compareInstants(input.now, operation.expiresAt) >= 0) {
          // Read-only conflict; cleanupExpired owns the transition.
          return { kind: "conflict", reason: "operation_expired" } as ActivationResult;
        }
        if (operation.startConfigBinding !== input.currentConfigBinding) {
          // Read-only conflict: a failed activation must not consume the
          // operation, because the operator may still complete it correctly.
          return { kind: "conflict", reason: "start_config_changed" } as ActivationResult;
        }
        if (operation.phase === "needs_configuration" && input.target === null) {
          return { kind: "conflict", reason: "target_required" } as ActivationResult;
        }
        const current = draft.slots.get(operation.platform) ?? emptySlot(operation.platform);
        // The observed revision must match both the operation's initial revision
        // and the current slot, so a newer slot value cannot revive it.
        if (
          input.expectedRevision !== operation.expectedRevision ||
          input.expectedRevision !== current.revision
        ) {
          return { kind: "conflict", reason: "revision_mismatch" } as ActivationResult;
        }
        const nextSlot = freezeSlot({
          platform: operation.platform,
          status: "active",
          revision: current.revision + 1,
          bindingId: input.bindingId,
          envelope: input.envelope,
          payloadRevision: input.payloadRevision,
          payloadSchemaVersion: input.payloadSchemaVersion,
          expiresAt: input.expiresAt,
          target: input.target,
          refreshLease: null,
          refreshState: "ready",
          lastRefreshCommitFingerprint: null,
          updatedAt: input.now,
        });
        draft.slots.set(operation.platform, nextSlot);
        const receipt = freezeReceipt({
          ...input.receipt,
          platform: operation.platform,
          operationId: operation.operationId,
          revision: nextSlot.revision,
        });
        draft.operations.set(
          operation.operationId,
          freezeOperation({
            ...operation,
            phase: "completed",
            receipt,
            candidateEnvelope: null,
            candidatePayloadRevision: null,
            candidatePayloadSchemaVersion: null,
            missingFields: Object.freeze([]),
            errorCode: null,
            updatedAt: input.now,
          }),
        );
        consumeFault("failNextActivationAfterStage");
        return { kind: "activated", revision: nextSlot.revision, receipt } as ActivationResult;
      });
    },

    async acquireRefresh(input: RefreshClaim) {
      return transact((draft) => {
        const platform = input.platform;
        const current = draft.slots.get(platform) ?? emptySlot(platform);
        if (current.status === "empty") {
          return { kind: "conflict", reason: "not_found" } as RefreshClaimResult;
        }
        if (current.status === "tombstone") {
          return { kind: "conflict", reason: "tombstone" } as RefreshClaimResult;
        }
        if (current.refreshState === "reconnect_required") {
          return { kind: "conflict", reason: "reconnect_required" } as RefreshClaimResult;
        }
        const existingLease = current.refreshLease;
        if (existingLease !== null) {
          // Any unfinished lease blocks another exchange. Once its safety
          // window elapsed the only safe answer is reconnect_required: the
          // uncertain token is never handed to a second exchange, and no
          // mutation happens here (projection only).
          return {
            kind: "conflict",
            reason:
              compareInstants(input.now, existingLease.expiresAt) < 0
                ? "lease_held"
                : "reconnect_required",
          } as RefreshClaimResult;
        }
        if (current.revision !== input.expectedRevision) {
          return { kind: "conflict", reason: "revision_mismatch" } as RefreshClaimResult;
        }
        if (current.envelope === null) {
          return { kind: "conflict", reason: "no_refresh_payload" } as RefreshClaimResult;
        }
        if (consumeFlag("refreshClaimResultUnknownOnce")) {
          return { kind: "unknown" } as RefreshClaimResult;
        }
        const nextLease = freezeLease({
          token: input.leaseToken,
          acquiredAt: input.now,
          expiresAt: instantAfter(input.now, input.leaseDurationMs),
          revision: current.revision,
        });
        const next = freezeSlot({ ...current, refreshLease: nextLease, updatedAt: input.now });
        draft.slots.set(platform, next);
        if (consumeFlag("refreshClaimCommittedUnknownOnce")) {
          // The lease committed; only the caller's view of the result was lost.
          return { kind: "unknown" } as RefreshClaimResult;
        }
        return { kind: "acquired", snapshot: next, lease: nextLease } as RefreshClaimResult;
      });
    },

    async completeRefresh(input: RefreshCommit) {
      return transact((draft) => {
        const current = draft.slots.get(input.platform) ?? emptySlot(input.platform);
        const fingerprint = refreshCommitFingerprint(input);
        // A lost response is retried with identical input, which now sees the
        // already-advanced revision. Only an exact identity replay counts:
        // ciphertext plus revision looking equal is not enough.
        const appliedReplay =
          current.revision === input.expectedRevision + 1 &&
          current.lastRefreshCommitFingerprint !== null &&
          current.lastRefreshCommitFingerprint === fingerprint;
        if (appliedReplay) {
          return COMMIT_ALREADY_APPLIED;
        }
        if (current.revision !== input.expectedRevision) {
          return commitConflict("revision_mismatch");
        }
        const lease = current.refreshLease;
        if (lease === null || lease.token !== input.leaseToken) {
          return commitConflict("lease_mismatch");
        }
        if (compareInstants(input.now, lease.expiresAt) >= 0) {
          // Past the safety window the exchange result is no longer trusted.
          return commitConflict("reconnect_required");
        }
        if (input.target !== null && !sameTarget(input.target, current.target)) {
          // A refresh must never retarget or rebind the connection.
          return commitConflict("guard_mismatch");
        }
        const next = freezeSlot({
          ...current,
          revision: current.revision + 1,
          envelope: input.envelope,
          payloadRevision: input.payloadRevision,
          payloadSchemaVersion: input.payloadSchemaVersion,
          expiresAt: input.expiresAt,
          target: current.target,
          refreshLease: null,
          refreshState: "ready",
          lastRefreshCommitFingerprint: fingerprint,
          updatedAt: input.now,
        });
        draft.slots.set(input.platform, next);
        consumeFault("failNextRefreshCommitAfterStage");
        return COMMIT_APPLIED;
      });
    },

    async markReconnectRequired(input: RefreshFailure) {
      return transact((draft) => {
        const current = draft.slots.get(input.platform) ?? emptySlot(input.platform);
        if (current.status === "empty") {
          return commitConflict("not_found");
        }
        if (current.status === "tombstone") {
          return commitConflict("terminal");
        }
        const lease = current.refreshLease;
        // The failure must belong to the lease that actually failed: exact
        // token and revision, otherwise a stale token could poison a newer
        // replacement connection.
        if (lease === null || lease.token !== input.leaseToken) {
          return commitConflict("lease_mismatch");
        }
        if (current.revision !== input.expectedRevision) {
          return commitConflict("revision_mismatch");
        }
        const next = freezeSlot({
          ...current,
          refreshLease: null,
          // All three failure reasons are conservative: we cannot prove the
          // token was not rotated, so automatic refresh stops.
          refreshState: "reconnect_required",
          updatedAt: input.now,
        });
        draft.slots.set(input.platform, next);
        return COMMIT_APPLIED;
      });
    },

    async readAuthOperation(input) {
      return state.operations.get(input.operationId) ?? null;
    },

    async cleanupExpired(input: MaintenanceBudget) {
      requireMaintenanceBudget(input);
      return transact((draft) => {
        // One eligible union, one budget, one write per row: a row that both
        // holds residual secrets and still needs a phase change is mutated
        // exactly once, and the report counts the rows actually changed.
        const eligible = sortedOperations(draft)
          .filter(
            (operation) =>
              compareInstants(input.now, operation.expiresAt) >= 0 &&
              (needsPhaseTransition(operation.phase) ||
                operation.requestSecret !== null ||
                operation.candidateEnvelope !== null),
          )
          .slice(0, input.limit);
        for (const operation of eligible) {
          draft.operations.set(
            operation.operationId,
            scrubOperation(operation, input.now, needsPhaseTransition(operation.phase)),
          );
        }
        return { removed: eligible.length } as CleanupResult;
      });
    },
  };

  const queue: JobQueue = {
    async send(message) {
      const decoded = decodeQueueEnvelopeV1(message);
      if (decoded.kind === "invalid") {
        throw new JobQueueError(
          "queue envelope was rejected",
          "failed",
          "INVALID_ENVELOPE",
        );
      }
      const fault = pendingFaults.get("failNextQueueSend");
      if (fault !== undefined) {
        pendingFaults.delete("failNextQueueSend");
        throw fault instanceof Error
          ? fault
          : new JobQueueError("queue send failed", "unknown", "SEND_UNKNOWN");
      }
      sentEnvelopes.push(decoded.envelope);
    },
  };

  const archive: ArchiveStore = {
    async put(key: ArchiveKey, payload: SanitizedArchive) {
      if (!isSafeArchiveKey(key)) {
        throw new InvalidContractInputError("archive key is not an allowlisted logical key");
      }
      assertSanitizedArchive(payload);
      state = transact((draft) => {
        draft.archives.set(key, Object.freeze({ ...payload }));
        return draft;
      });
    },
    async get(key: ArchiveKey) {
      const payload = state.archives.get(key);
      if (payload === undefined) {
        return null;
      }
      if (archiveExpired(payload, currentNow)) {
        return null;
      }
      return payload;
    },
    async delete(key: ArchiveKey) {
      state = transact((draft) => {
        draft.archives.delete(key);
        return draft;
      });
    },
  };

  const blobs: BlobStore = {
    async put(key: BlobKey, body: Uint8Array | ReadableStream<Uint8Array>, metadata: BlobMetadata) {
      if (!isSafeBlobKey(key)) {
        throw new InvalidContractInputError("blob key is not an allowlisted logical key");
      }
      const bytes = body instanceof Uint8Array ? body : await readStream(body);
      const stored: BlobRead = Object.freeze({
        key,
        body: bytes,
        contentType: metadata.contentType,
        size: bytes.byteLength,
      });
      state = transact((draft) => {
        draft.blobs.set(key, stored);
        return draft;
      });
      return Object.freeze({
        key,
        size: stored.size,
        contentType: stored.contentType,
        checksum: metadata.checksum,
      }) as StoredBlob;
    },
    async get(key: BlobKey) {
      return state.blobs.get(key) ?? null;
    },
    async delete(key: BlobKey) {
      state = transact((draft) => {
        draft.blobs.delete(key);
        return draft;
      });
    },
    async exists(key: BlobKey) {
      return state.blobs.has(key);
    },
  };

  const logger: Logger = {
    write(event: SafeLogEvent): void {
      logEvents.push(Object.freeze({ ...event }));
    },
  };

  const diagnostics: DiagnosticsReader = {
    async readSnapshot() {
      const now = currentNow;
      const jobs = [...state.jobs.values()];
      const pending = jobs.filter((job) => job.status === "pending");
      const due = pending
        .filter((job) => isDueAt(job.availableAt, now))
        .sort((left, right) => compareInstants(left.availableAt, right.availableAt));
      const oldest = due[0] ?? null;
      const publications = [...state.publications.values()].map((row) => row.publication);
      // Current transport failures only: terminal dead_lettered publications
      // plus publications still waiting whose current job already saw a DLQ.
      // Late DLQ arrivals for published/unknown results or superseded jobs are
      // excluded because they are not the publication's current job.
      const deadLettered = publications.filter((publication) => {
        if (publication.status === "failed" && publication.terminalReason === "dead_lettered") {
          return true;
        }
        if (publication.status !== "pending" && publication.status !== "scheduled") {
          return false;
        }
        const currentJob =
          publication.currentJobId === null ? undefined : state.jobs.get(publication.currentJobId);
        return currentJob !== undefined && currentJob.dlqSeenAt !== null;
      }).length;
      return Object.freeze({
        observedAt: now,
        pendingOutbox: pending.length,
        oldestDueAt: oldest === null ? null : oldest.availableAt,
        oldestAgeSeconds:
          oldest === null
            ? null
            : Math.max(0, Math.floor((Date.parse(now) - Date.parse(oldest.availableAt)) / 1000)),
        retryScheduled: publications.filter(
          (publication) => publication.status === "pending" && publication.retryAt !== null,
        ).length,
        deadLettered,
        latestAttemptArchiveFailures: publications.filter(
          (publication) => publication.archiveStatus === "failed",
        ).length,
        storage: Object.freeze({
          approximateBytes: null,
          limitBytes: null,
          utilization: null,
          reason: "size_unavailable",
          observedAt: now,
        }),
      }) as SafeDiagnostics;
    },
  };

  return {
    publishing,
    outbox,
    credentials,
    queue,
    archive,
    blobs,
    cipher: options.cipher ?? createTestCipher(),
    logger,
    diagnostics,
    faults,
    clock,
    sentEnvelopes,
    logEvents,
    snapshot(): FakeSnapshot {
      return freezeSnapshot({
        posts: sortedKeys(state.posts).map((key) => requireRow(state.posts.get(key), key).post),
        publications: sortedKeys(state.publications).map(
          (key) => requireRow(state.publications.get(key), key).publication,
        ),
        jobs: sortedKeys(state.jobs).map((key) => requireRow(state.jobs.get(key), key)),
        createRecords: sortedKeys(state.createRecords)
          .map((key) => projectCreateRecord(state, requireRow(state.createRecords.get(key), key)))
          .filter((record): record is IdempotentPostRecord => record !== null),
        slots: [...state.slots.values()].sort((left, right) =>
          left.platform < right.platform ? -1 : left.platform > right.platform ? 1 : 0,
        ),
        operations: sortedKeys(state.operations).map((key) =>
          requireRow(state.operations.get(key), key),
        ),
        archives: Object.freeze(sortedKeys(state.archives)),
        blobKeys: Object.freeze(sortedKeys(state.blobs)),
        sentEnvelopes: Object.freeze([...sentEnvelopes]),
      });
    },
    reset(): void {
      state = emptyState();
      sentEnvelopes.length = 0;
      logEvents.length = 0;
      faults.clear();
    },
    placeResidualSecrets(input): void {
      state = transact((draft) => {
        const operation = draft.operations.get(input.operationId);
        if (operation === undefined) {
          throw new CorruptStoreRecordError("residual-secret fixture targets a missing operation");
        }
        draft.operations.set(
          operation.operationId,
          freezeOperation({
            ...operation,
            requestSecret: input.requestSecret,
            requestSecretPurpose: "oauth_request_secret",
            requestSecretRevision: operation.requestSecretRevision ?? 1,
            candidateEnvelope: input.candidateSecret,
            candidatePayloadRevision: operation.candidatePayloadRevision ?? 1,
            candidatePayloadSchemaVersion: operation.candidatePayloadSchemaVersion ?? 1,
            updatedAt: input.now,
          }),
        );
        return draft;
      });
    },
  };
}

export interface StoreHarness {
  readonly publishing: PublishingStore;
  readonly outbox: OutboxStore;
  readonly credentials: CredentialStore;
  readonly diagnostics: DiagnosticsReader;
  reset(): Promise<void>;
  /**
   * Test-only fixture: place residual secrets on an existing operation so the
   * cleanup contract can be proven for rows written by earlier versions or
   * interrupted tooling. Adapters may implement this with a raw fixture write.
   */
  placeResidualSecrets?(input: {
    readonly operationId: string;
    readonly requestSecret: EncryptedCredential;
    readonly candidateSecret: EncryptedCredential;
    readonly now: IsoInstant;
  }): Promise<void>;
}

export function createSnapshotFakeHarness(fake: SnapshotFake = createSnapshotFake()): StoreHarness {
  return {
    publishing: fake.publishing,
    outbox: fake.outbox,
    credentials: fake.credentials,
    diagnostics: fake.diagnostics,
    async reset() {
      fake.reset();
    },
    async placeResidualSecrets(input) {
      fake.placeResidualSecrets(input);
    },
  };
}

function requireRow<T>(row: T | undefined, key: string): T {
  if (row === undefined) {
    throw new CorruptStoreRecordError(`missing row: ${key}`);
  }
  return row;
}

function sortedKeys<T>(map: ReadonlyMap<string, T>): string[] {
  return [...map.keys()].sort();
}

function sortedPublications(draft: FakeState): PublicationSnapshot[] {
  return [...draft.publications.values()]
    .map((row) => row.publication)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function sortedJobs(draft: FakeState): OutboxJob[] {
  return [...draft.jobs.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function sortedOperations(draft: FakeState): StoredAuthOperation[] {
  return [...draft.operations.values()].sort((left, right) =>
    left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
  );
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_STREAM_BYTES) {
        throw new InvalidContractInputError("blob body exceeds the fake store bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function instantAfter(base: IsoInstant, offsetMs: number): IsoInstant {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function isTerminalPublication(status: PublicationStatus): boolean {
  return TERMINAL_PUBLICATION_STATUSES.includes(status);
}

function aggregatePostStatus(
  publications: readonly PublicationSnapshot[],
  scheduledAt: IsoInstant | null,
): PostStatus {
  if (publications.length === 0) {
    return scheduledAt === null ? "queued" : "scheduled";
  }
  const published = publications.filter((publication) => publication.status === "published").length;
  const unsettled = publications.filter(
    (publication) => !isTerminalPublication(publication.status),
  ).length;
  if (unsettled === 0) {
    if (published === publications.length) return "published";
    if (published === 0) return "failed";
    return "partial";
  }
  if (published > 0) {
    return "partial";
  }
  return scheduledAt === null ? "queued" : "scheduled";
}

function makePostSnapshot(input: CreatePostTransaction): PostSnapshot {
  return freezePost({
    id: input.post.id,
    status: input.post.status,
    content: input.post.content,
    platforms: Object.freeze([...input.post.platforms]),
    overrides: input.post.overrides,
    scheduledAt: input.post.scheduledAt,
    createdAt: input.post.createdAt,
    updatedAt: input.now,
  });
}

function makePublicationSnapshot(
  publication: CreatePostTransaction["publications"][number],
  now: IsoInstant,
  currentJobId: string | null,
): PublicationSnapshot {
  return freezePublication({
    id: publication.id,
    postId: publication.postId,
    platform: publication.platform,
    provider: publication.provider,
    content: publication.content,
    status: publication.status,
    attempts: 0,
    claimToken: null,
    attemptId: null,
    currentJobId,
    retryAt: null,
    publishingAt: null,
    publishedAt: null,
    credentialBinding: publication.credentialBinding,
    credentialRevisionAtCreate: publication.credentialRevision,
    terminalReason: null,
    errorCode: null,
    errorAmbiguous: false,
    externalId: null,
    externalUrl: null,
    archiveKey: null,
    archiveStatus: "not_requested",
    committedOutcome: null,
    createdAt: publication.createdAt,
    updatedAt: now,
  });
}

function makeJob(job: CreatePostTransaction["jobs"][number], now: IsoInstant): OutboxJob {
  return freezeJob({
    id: job.id,
    kind: job.kind,
    payloadVersion: 1,
    aggregateId: job.aggregateId,
    attemptNo: job.attemptNo,
    availableAt: job.availableAt,
    status: "pending",
    dispatchRevision: 0,
    dispatchAttemptCount: 0,
    lastDispatchErrorCode: null,
    dispatchedAt: null,
    createdAt: now,
    updatedAt: now,
    recoveryCount: 0,
    recoveryAfter: null,
    dlqSeenAt: null,
    transportReason: null,
  });
}

function toSummary(publication: PublicationSnapshot): PublicationSummary {
  return Object.freeze({
    publicationId: publication.id,
    platform: publication.platform,
    status: publication.status,
    externalId: publication.externalId,
    externalUrl: publication.externalUrl,
    errorCode: publication.errorCode,
    errorAmbiguous: publication.errorAmbiguous,
    terminalReason: publication.terminalReason,
  });
}

function emptySlot(platform: Platform): EncryptedSlotSnapshot {
  return freezeSlot({
    platform,
    status: "empty",
    revision: 0,
    bindingId: null,
    envelope: null,
    payloadRevision: null,
    payloadSchemaVersion: null,
    expiresAt: null,
    target: null,
    refreshLease: null,
    refreshState: "ready",
    lastRefreshCommitFingerprint: null,
    updatedAt: null,
  });
}

function expireOperation(operation: StoredAuthOperation, now: IsoInstant): StoredAuthOperation {
  return scrubOperation(operation, now, true);
}

function needsPhaseTransition(phase: StoredAuthOperation["phase"]): boolean {
  return phase !== "completed" && phase !== "failed" && phase !== "expired";
}

/**
 * Clear residual secrets, and optionally move a non-terminal operation to
 * `expired`. Terminal phases and their receipts are preserved.
 */
function scrubOperation(
  operation: StoredAuthOperation,
  now: IsoInstant,
  expire: boolean,
): StoredAuthOperation {
  return freezeOperation({
    ...operation,
    ...(expire ? { phase: "expired" as const } : {}),
    candidateEnvelope: null,
    candidatePayloadRevision: null,
    candidatePayloadSchemaVersion: null,
    requestSecret: null,
    requestSecretPurpose: null,
    requestSecretRevision: null,
    updatedAt: now,
  });
}

function envelopesEqual(left: EncryptedCredential, right: EncryptedCredential): boolean {
  return (
    left.version === right.version &&
    left.algorithm === right.algorithm &&
    left.keyId === right.keyId &&
    left.iv === right.iv &&
    left.ciphertext === right.ciphertext
  );
}

function sameTarget(left: SafeTarget, right: SafeTarget | null): boolean {
  return right !== null && left.label === right.label && left.source === right.source;
}

function freezePost(post: PostSnapshot): PostSnapshot {
  return Object.freeze(post);
}

function freezePublication(publication: PublicationSnapshot): PublicationSnapshot {
  return Object.freeze(publication);
}

function freezeJob(job: OutboxJob): OutboxJob {
  return Object.freeze(job);
}

function freezeSlot(slot: EncryptedSlotSnapshot): EncryptedSlotSnapshot {
  return Object.freeze(slot);
}

function freezeLease(lease: RefreshLease): RefreshLease {
  return Object.freeze(lease);
}

function freezeOperation(operation: StoredAuthOperation): StoredAuthOperation {
  return Object.freeze(operation);
}

function freezeReceipt<T extends { readonly platform: Platform }>(receipt: T): T {
  return Object.freeze(receipt);
}

function freezeExecution(execution: ExecutionSnapshot): ExecutionSnapshot {
  return Object.freeze({
    publication: freezePublication(execution.publication),
    post: freezePost(execution.post),
    job: freezeJob(execution.job),
  });
}

function freezeCommittedOutcome(key: string, fingerprint: string): CommittedOutcomeIdentity {
  return Object.freeze({ key, fingerprint });
}

function freezeSnapshot(snapshot: FakeSnapshot): FakeSnapshot {
  return Object.freeze({
    ...snapshot,
    posts: Object.freeze([...snapshot.posts]),
    publications: Object.freeze([...snapshot.publications]),
    jobs: Object.freeze([...snapshot.jobs]),
    createRecords: Object.freeze([...snapshot.createRecords]),
    slots: Object.freeze([...snapshot.slots]),
    operations: Object.freeze([...snapshot.operations]),
  });
}

function commitCreateConflict(
  reason: "credential_revision_mismatch" | "duplicate_publication" | "duplicate_job" | "duplicate_attempt",
): CreateCommitResult {
  return Object.freeze({ kind: "conflict" as const, reason });
}
