/**
 * Semantic transaction port for publishing state.
 *
 * One concrete adapter (D1) may implement this together with `OutboxStore` and
 * `CredentialStore`; the port never exposes SQL, statement results, bindings or
 * transaction callbacks. Every method below is one logical transaction:
 * either all guarded rows change or none does.
 */

import type {
  ClaimCondition,
  ClaimResult,
  ArchiveResultCommit,
  CreateCommitResult,
  CreatePostTransaction,
  DeadLetterCondition,
  DeadLetterOutcome,
  ExecutionCommit,
  ExecutionSnapshot,
  IdempotentPostRecord,
  PreExecutionRejection,
} from "../contracts/execution.js";
import type {
  CommitResult,
  MaintenanceBudget,
  RecoveryResult,
} from "../contracts/primitives.js";

export interface IdempotencyLookup {
  readonly scope: "posts.create.v1";
  /** Optional public `Idempotency-Key`; null when the caller sent none. */
  readonly key: string | null;
}

export interface ExecutionLookup {
  readonly jobId: string;
  readonly publicationId: string;
}

export interface PublishingStore {
  /**
   * Current idempotency record including the Post's current status, or null.
   * A null key has nothing to look up and returns null.
   */
  findIdempotentPost(input: IdempotencyLookup): Promise<IdempotentPostRecord | null>;

  /**
   * Atomically commit Post + Publications + initial outbox jobs + idempotency
   * key while every credential revision/slot guard still holds.
   *
   * A key that already exists returns `replayed` with the stored record so the
   * application applies the canonical request comparison rule; the store never
   * decides 200-vs-409 and never writes a second time.
   */
  createPostWithDispatch(input: CreatePostTransaction): Promise<CreateCommitResult>;

  /** Immutable snapshot for preparation, or null when the pair does not exist. */
  getExecution(input: ExecutionLookup): Promise<ExecutionSnapshot | null>;

  /**
   * Claim a due, current, unterminal job before any provider call. Preparation
   * (credential read, decode, Publisher construction) must already have
   * happened outside the claim.
   */
  claimExecution(input: ClaimCondition): Promise<ClaimResult>;

  /**
   * Persist the provider outcome, a terminal failure or a safe retry.
   *
   * Replaying the same attempt with the same fingerprint returns
   * `already_applied` and never re-enters the provider. A terminal commit also
   * cancels the job's transport intent.
   */
  commitExecution(input: ExecutionCommit): Promise<CommitResult>;

  /**
   * Record a permanent pre-provider failure (configuration or binding) as a
   * terminal, non-ambiguous result and cancel the unsent job.
   */
  rejectBeforeExecution(input: PreExecutionRejection): Promise<CommitResult>;

  /**
   * Settle a DLQ arrival. Only a current, unclaimed, due job becomes
   * `dead_lettered`; a future job records transport failure without losing its
   * `availableAt`; terminal/old/actively-claimed jobs only get transport
   * metadata.
   */
  settleDeadLetter(input: DeadLetterCondition): Promise<DeadLetterOutcome>;

  /**
   * Bounded maintenance: stale publishing claims become `unknown`, stalled
   * dispatched jobs are rearmed at most `MAX_STALLED_RECOVERIES` times, and
   * due jobs that already saw a DLQ are settled `dead_lettered`.
   */
  recoverStaleClaims(input: MaintenanceBudget): Promise<RecoveryResult>;

  /**
   * Record the archive outcome for the current attempt and planned logical key.
   *
   * Guarded on both: a late result for an older attempt or a different key is a
   * conflict with zero mutations, so it cannot mark a newer attempt's archive.
   * An attempt id is "current" while its claim is live, and after a terminal
   * commit that cleared it the identity of the attempt that just completed
   * still counts, so its own archive result can land before the next claim. A
   * new claim clears the previous archive plan.
   */
  recordArchiveResult(input: ArchiveResultCommit): Promise<CommitResult>;
}
