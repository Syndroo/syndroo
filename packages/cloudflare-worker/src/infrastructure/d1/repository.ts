/**
 * 0.5.0 semantic D1 repository.
 *
 * One concrete repository implements `PublishingStore`, `OutboxStore`,
 * `CredentialStore` and `DiagnosticsReader`. The legacy read/claim path in
 * `src/repository.ts` stays available until Task 5/6 rewire the runtime; this
 * module is the fenced execution path that the ports describe.
 *
 * Every mutation is one `D1Database.batch`. Because a conditional UPDATE that
 * matches zero rows does not roll back sibling statements, each batch writes a
 * private per-invocation `mutation_marker` in its winning statement and gates
 * every dependent write on that exact token. A zero-row guard therefore leaves
 * the whole batch inert instead of authorising partial writes.
 */

import type { Platform } from "@syndroo/core";
import type {
  ActivationCommit,
  ActivationResult,
  ArchiveResultCommit,
  AuthOperationStart,
  CandidateCommit,
  ClaimCondition,
  ClaimResult,
  CleanupResult,
  CommitResult,
  CreateCommitResult,
  CreatePostTransaction,
  CredentialStore,
  DeadLetterCondition,
  DeadLetterOutcome,
  DiagnosticsReader,
  DispatchObservation,
  ExecutionCommit,
  ExecutionSnapshot,
  IdempotentPostRecord,
  MaintenanceBudget,
  OAuthClaim,
  OAuthClaimResult,
  OutboxJob,
  OutboxStore,
  PreExecutionRejection,
  PublishingStore,
  ReadyQuery,
  RearmCondition,
  RearmResult,
  RecoveryResult,
  RefreshClaim,
  RefreshClaimResult,
  RefreshCommit,
  RefreshFailure,
  SafeDiagnostics,
  SlotMutation,
  SlotMutationResult,
  StoredAuthOperation,
} from "@syndroo/application";
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
  StoreUnavailable,
  commitConflict,
  executionCommitFingerprint,
  isDueAt,
  refreshCommitFingerprint,
  requireMaintenanceBudget,
  validateCreatePostTransaction,
} from "@syndroo/application";

import {
  toExecutionSnapshot,
  toIdempotentRecord,
  toOutboxJob,
  toSlotSnapshot,
  toStoredAuthOperation,
  type CredentialRow,
  type OAuthOperationRow,
  type OutboxJobRow,
  type PostRow,
  type PublicationRow,
} from "./mappers.js";

export interface D1MetricsEvent {
  readonly op: string;
  readonly statements: number;
  readonly changes: number;
  readonly rowsRead: number | null;
  readonly rowsWritten: number | null;
  readonly durationMs: number;
}

/** Runtime-only observer so Task 8 can sample budgets without D1 types in ports. */
export interface D1MetricsObserver {
  observe(event: D1MetricsEvent): void;
}

export interface D1RepositoryOptions {
  readonly now?: () => string;
  readonly metrics?: D1MetricsObserver;
  readonly randomId?: () => string;
}

const SELECT_POST =
  "SELECT id, content, platforms, overrides, scheduled_at, status, created_at, updated_at, idempotency_key, request_fingerprint FROM posts";
const SELECT_PUBLICATION =
  "SELECT id, post_id, platform, provider, content, status, attempts, external_id, external_url, error_code, error_ambiguous, retry_at, publishing_at, published_at, created_at, updated_at, credential_binding, credential_revision_at_create, claim_token, attempt_id, current_job_id, terminal_reason, archive_key, archive_status, committed_outcome_key, committed_outcome_fingerprint FROM publications";
const SELECT_JOB =
  "SELECT id, kind, payload_version, aggregate_id, attempt_no, available_at, status, dispatch_revision, dispatch_attempt_count, last_dispatch_error_code, dispatched_at, created_at, updated_at, recovery_count, recovery_after, dlq_seen_at, transport_reason FROM outbox_jobs";
const SELECT_CREDENTIAL =
  "SELECT platform, data, created_at, updated_at, expires_at, revision, binding_id, tombstone, payload_revision, payload_schema_version, envelope, target_label, target_source, refresh_state, refresh_lease_token, refresh_lease_acquired_at, refresh_lease_expires_at, refresh_lease_revision, last_refresh_commit_fingerprint FROM credentials";
const SELECT_OPERATION =
  "SELECT operation_id, platform, state, phase, expected_revision, canonical_callback_url, start_config_binding, request_token, request_secret_envelope, request_secret_purpose, request_secret_revision, candidate_envelope, candidate_payload_revision, candidate_payload_schema_version, candidate_target_label, candidate_target_source, receipt, missing_fields, error_code, expires_at, created_at, updated_at FROM oauth_state";

/** SQL aggregate mirroring the portable post-status rule. */
const POST_AGGREGATE_SQL = `(
  SELECT CASE
    WHEN SUM(CASE WHEN p.status IN ('pending','scheduled','publishing') THEN 1 ELSE 0 END) = 0
      THEN CASE
        WHEN SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) = COUNT(*) THEN 'published'
        WHEN SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) = 0 THEN 'failed'
        ELSE 'partial' END
    ELSE CASE
      WHEN SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) > 0 THEN 'partial'
      WHEN posts.scheduled_at IS NULL THEN 'queued'
      ELSE 'scheduled' END
  END
  FROM publications p WHERE p.post_id = posts.id
)`;

export class D1Repository
  implements PublishingStore, OutboxStore, CredentialStore, DiagnosticsReader
{
  public constructor(
    private readonly db: D1Database,
    private readonly options: D1RepositoryOptions = {},
  ) {}

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private marker(): string {
    return (
      this.options.randomId?.() ??
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`)
    );
  }

  /**
   * Best-effort metrics: a throwing observer must never change behaviour or
   * leak its payload into a storage result.
   */
  private safeObserve(event: D1MetricsEvent): void {
    try {
      this.options.metrics?.observe(event);
    } catch {
      // Observers are diagnostics only; failures are discarded on purpose.
    }
  }

  /**
   * Guarded statement factory. `prepare` and `bind` can raise raw D1 errors
   * (statement text, arity, bound values), so both are wrapped here and the
   * result is a fixed, cause-free storage error.
   */
  private prepare(sql: string): D1PreparedStatement {
    let statement: D1PreparedStatement;
    try {
      statement = this.db.prepare(sql);
    } catch (error) {
      throw storageFailure("prepare", error);
    }
    return new Proxy(statement, {
      get: (target, key) => {
        if (key === "bind") {
          return (...params: unknown[]) => {
            try {
              return target.bind(...params);
            } catch (error) {
              throw storageFailure("bind", error);
            }
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
  }

  private async runBatch(op: string, statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const started = Date.now();
    let results: D1Result[];
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      this.safeObserve({
        op,
        statements: statements.length,
        changes: 0,
        rowsRead: null,
        rowsWritten: null,
        durationMs: Date.now() - started,
      });
      throw storageFailure(op, error);
    }
    let changes = 0;
    let rowsRead: number | null = 0;
    let rowsWritten: number | null = 0;
    for (const result of results) {
      changes += Number(result.meta?.changes ?? 0);
      const read = (result.meta as { rows_read?: number } | undefined)?.rows_read;
      const written = (result.meta as { rows_written?: number } | undefined)?.rows_written;
      rowsRead = read === undefined || rowsRead === null ? null : rowsRead + read;
      rowsWritten = written === undefined || rowsWritten === null ? null : rowsWritten + written;
    }
    this.safeObserve({
      op,
      statements: statements.length,
      changes,
      rowsRead,
      rowsWritten,
      durationMs: Date.now() - started,
    });
    return results;
  }

  private async readOne<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    const started = Date.now();
    try {
      const result = await this.prepare(sql)
        .bind(...params)
        .first<T>();
      return result;
    } catch (error) {
      throw storageFailure("read", error);
    } finally {
      this.safeObserve({
        op: "read",
        statements: 1,
        changes: 0,
        rowsRead: null,
        rowsWritten: null,
        durationMs: Date.now() - started,
      });
    }
  }

  private async readAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const started = Date.now();
    try {
      const result = await this.prepare(sql)
        .bind(...params)
        .all<T>();
      return (result.results ?? []) as T[];
    } catch (error) {
      throw storageFailure("read", error);
    } finally {
      this.safeObserve({
        op: "read",
        statements: 1,
        changes: 0,
        rowsRead: null,
        rowsWritten: null,
        durationMs: Date.now() - started,
      });
    }
  }

  private static changesOf(results: D1Result[], index: number): number {
    return Number(results[index]?.meta?.changes ?? 0);
  }

  // -------------------------------------------------------------------------
  // PublishingStore
  // -------------------------------------------------------------------------

  public async findIdempotentPost(input: {
    readonly scope: "posts.create.v1";
    readonly key: string | null;
  }): Promise<IdempotentPostRecord | null> {
    if (input.key === null) {
      return null;
    }
    const post = await this.readOne<PostRow>(
      `${SELECT_POST} WHERE idempotency_key = ? LIMIT 1`,
      input.key,
    );
    if (post === null) {
      return null;
    }
    return this.readCreateRecord(post.id);
  }

  private async readCreateRecord(postId: string): Promise<IdempotentPostRecord | null> {
    const post = await this.readOne<PostRow>(`${SELECT_POST} WHERE id = ?`, postId);
    if (post === null) {
      return null;
    }
    const publications = await this.readAll<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE post_id = ? ORDER BY id`,
      postId,
    );
    const jobIds: string[] = [];
    for (const publication of publications) {
      const jobs = await this.readAll<OutboxJobRow>(
        `${SELECT_JOB} WHERE aggregate_id = ? ORDER BY attempt_no, id`,
        publication.id,
      );
      jobIds.push(...jobs.map((job) => job.id));
    }
    return toIdempotentRecord(post, publications, jobIds);
  }

  public async createPostWithDispatch(input: CreatePostTransaction): Promise<CreateCommitResult> {
    validateCreatePostTransaction(input);
    if (input.idempotencyKey !== null) {
      const existing = await this.findIdempotentPost({
        scope: "posts.create.v1",
        key: input.idempotencyKey,
      });
      if (existing !== null) {
        return Object.freeze({ kind: "replayed" as const, record: existing });
      }
    }

    if ((await this.readOne<{ id: string }>("SELECT id FROM posts WHERE id = ?", input.post.id)) !== null) {
      return commitCreateConflict("duplicate_publication");
    }
    for (const publication of input.publications) {
      if ((await this.readOne<{ id: string }>("SELECT id FROM publications WHERE id = ?", publication.id)) !== null) {
        return commitCreateConflict("duplicate_publication");
      }
    }
    for (const job of input.jobs) {
      if ((await this.readOne<{ id: string }>("SELECT id FROM outbox_jobs WHERE id = ?", job.id)) !== null) {
        return commitCreateConflict("duplicate_job");
      }
    }

    const marker = this.marker();
    const guardClauses: string[] = [];
    const guardParams: unknown[] = [];
    for (const guard of input.credentialGuards) {
      if (guard.bindingId === null) {
        guardClauses.push("COALESCE((SELECT revision FROM credentials WHERE platform = ?), 0) = ?");
        guardParams.push(guard.platform, guard.expectedRevision);
      } else {
        // The caller verified a specific slot binding; a rotated binding within
        // the same revision must still fail the guard.
        guardClauses.push(
          "COALESCE((SELECT revision FROM credentials WHERE platform = ?), 0) = ? AND (SELECT binding_id FROM credentials WHERE platform = ?) IS ?",
        );
        guardParams.push(
          guard.platform,
          guard.expectedRevision,
          guard.platform,
          guard.bindingId,
        );
      }
    }

    const statements: D1PreparedStatement[] = [
      this.prepare(
          `INSERT INTO posts (id, content, platforms, overrides, scheduled_at, status, created_at, updated_at, idempotency_key, request_fingerprint, mutation_marker)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           ${guardClauses.length === 0 ? "" : `WHERE ${guardClauses.join(" AND ")}`}`,
        )
        .bind(
          input.post.id,
          input.post.content,
          JSON.stringify(input.post.platforms),
          JSON.stringify(input.post.overrides ?? {}),
          input.post.scheduledAt,
          input.post.status,
          input.post.createdAt,
          input.now,
          input.idempotencyKey,
          input.requestFingerprint,
          marker,
          ...guardParams,
        ),
    ];

    for (const publication of input.publications) {
      const job = input.jobs.find((candidate) => candidate.aggregateId === publication.id);
      statements.push(
        this.prepare(
            `INSERT INTO publications (id, post_id, platform, provider, content, status, attempts, created_at, updated_at, credential_binding, credential_revision_at_create, current_job_id, archive_status, mutation_marker)
             SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'not_requested', ?
             WHERE (SELECT mutation_marker FROM posts WHERE id = ?) = ?`,
          )
          .bind(
            publication.id,
            publication.postId,
            publication.platform,
            publication.provider,
            publication.content,
            publication.status,
            publication.createdAt,
            input.now,
            publication.credentialBinding,
            publication.credentialRevision,
            job?.id ?? null,
            marker,
            input.post.id,
            marker,
          ),
      );
    }

    for (const job of input.jobs) {
      statements.push(
        this.prepare(
            `INSERT INTO outbox_jobs (id, kind, payload_version, aggregate_id, attempt_no, available_at, status, dispatch_revision, dispatch_attempt_count, created_at, updated_at, recovery_count, mutation_marker)
             SELECT ?, ?, 1, ?, ?, ?, 'pending', 0, 0, ?, ?, 0, ?
             WHERE (SELECT mutation_marker FROM posts WHERE id = ?) = ?`,
          )
          .bind(
            job.id,
            job.kind,
            job.aggregateId,
            job.attemptNo,
            job.availableAt,
            input.now,
            input.now,
            marker,
            input.post.id,
            marker,
          ),
      );
    }

    let results: D1Result[];
    try {
      results = await this.runBatch("createPostWithDispatch", statements);
    } catch (error) {
      if (input.idempotencyKey !== null) {
        const raced = await this.findIdempotentPost({
          scope: "posts.create.v1",
          key: input.idempotencyKey,
        });
        if (raced !== null) {
          return Object.freeze({ kind: "replayed" as const, record: raced });
        }
      }
      throw storageFailure("createPostWithDispatch", error);
    }

    if (D1Repository.changesOf(results, 0) !== 1) {
      const conflicted = await this.readOne<PostRow>(`${SELECT_POST} WHERE id = ?`, input.post.id);
      if (conflicted !== null) {
        return commitCreateConflict("duplicate_publication");
      }
      return commitCreateConflict("credential_revision_mismatch");
    }

    const record = await this.readCreateRecord(input.post.id);
    if (record === null) {
      throw new CorruptStoreRecordError("create committed without a readable record");
    }
    return Object.freeze({ kind: "created" as const, record });
  }

  public async getExecution(input: {
    readonly jobId: string;
    readonly publicationId: string;
  }): Promise<ExecutionSnapshot | null> {
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    const job = await this.readOne<OutboxJobRow>(`${SELECT_JOB} WHERE id = ?`, input.jobId);
    if (publication === null || job === null || job.aggregate_id !== publication.id) {
      return null;
    }
    const post = await this.readOne<PostRow>(`${SELECT_POST} WHERE id = ?`, publication.post_id);
    if (post === null) {
      throw new CorruptStoreRecordError("publication references a missing post");
    }
    return toExecutionSnapshot(publication, post, job);
  }

  public async claimExecution(input: ClaimCondition): Promise<ClaimResult> {
    const before = await this.getExecution({
      jobId: input.jobId,
      publicationId: input.publicationId,
    });
    // The returned snapshot is assembled from this pre-read, so it must be the
    // row the guarded batch will mutate: same current job and same next attempt.
    if (
      before === null ||
      before.publication.currentJobId !== input.jobId ||
      before.publication.attempts + 1 !== input.attemptNo
    ) {
      return Object.freeze({
        kind: "not_claimed" as const,
        reason: await this.explainClaimBlock(input),
      });
    }
    const marker = this.marker();
    const statements = [
      this.prepare(
          `UPDATE publications
           SET status = 'publishing', attempts = attempts + 1, claim_token = ?, attempt_id = ?,
               publishing_at = ?, archive_key = NULL, archive_status = 'not_requested',
               updated_at = ?, mutation_marker = ?
           WHERE id = ? AND current_job_id = ? AND claim_token IS NULL AND attempt_id IS NULL
             AND status IN ('pending', 'scheduled') AND attempts < ?
             AND attempts + 1 = ?
             AND EXISTS (SELECT 1 FROM outbox_jobs j
                         WHERE j.id = ? AND j.aggregate_id = publications.id
                           AND j.kind = 'delivery.execute' AND j.attempt_no = ?
                           AND j.payload_version = 1
                           AND j.status <> 'cancelled' AND j.dlq_seen_at IS NULL
                           AND j.available_at <= ?)
             AND COALESCE((SELECT revision FROM credentials WHERE platform = publications.platform), 0) = ?`,
        )
        .bind(
          input.claimToken,
          input.attemptId,
          input.now,
          input.now,
          marker,
          input.publicationId,
          input.jobId,
          PUBLISHER_MAX_ATTEMPTS,
          input.attemptNo,
          input.jobId,
          input.attemptNo,
          input.now,
          input.credentialSlotRevision,
        ),
      this.prepare(
          `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
           WHERE id = (SELECT post_id FROM publications WHERE id = ?)
             AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
        )
        .bind(input.now, input.publicationId, input.publicationId, marker),
    ];

    let results: D1Result[];
    try {
      results = await this.runBatch("claimExecution", statements);
    } catch {
      // An uncertain write acknowledgement authorises nothing: the caller must
      // not call the provider on local optimism.
      return Object.freeze({ kind: "unknown" as const });
    }
    if (D1Repository.changesOf(results, 0) !== 1) {
      return Object.freeze({
        kind: "not_claimed" as const,
        reason: await this.explainClaimBlock(input),
      });
    }
    // The winner snapshot comes from this invocation's own pre-read plus the
    // claim identity it just wrote. A concurrent later write must not be able
    // to change what the winner believes it holds.
    if (before === null) {
      throw new CorruptStoreRecordError("claim committed without a readable execution");
    }
    const claimedPublication = Object.freeze({
      ...before.publication,
      status: "publishing" as const,
      attempts: before.publication.attempts + 1,
      claimToken: input.claimToken,
      attemptId: input.attemptId,
      currentJobId: input.jobId,
      publishingAt: input.now,
      archiveKey: null,
      archiveStatus: "not_requested" as const,
      updatedAt: input.now,
    });
    return Object.freeze({
      kind: "claimed" as const,
      execution: Object.freeze({
        publication: claimedPublication,
        post: before.post,
        job: before.job,
      }),
    });
  }

  private async explainClaimBlock(
    input: ClaimCondition,
  ): Promise<
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
    | "dlq_seen"
  > {
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    const job = await this.readOne<OutboxJobRow>(`${SELECT_JOB} WHERE id = ?`, input.jobId);
    if (publication === null || job === null) return "not_found";
    if (job.kind !== "delivery.execute") return "kind_mismatch";
    if (job.payload_version !== 1) return "kind_mismatch";
    if (job.aggregate_id !== publication.id) return "entity_mismatch";
    if (job.attempt_no !== input.attemptNo) return "attempt_mismatch";
    if (job.status === "cancelled") return "cancelled_job";
    if (job.dlq_seen_at !== null) return "dlq_seen";
    if (publication.current_job_id !== input.jobId) return "not_current_job";
    if (publication.status === "published" || publication.status === "failed") return "terminal";
    if (publication.claim_token !== null) return "already_claimed";
    if (publication.status !== "pending" && publication.status !== "scheduled") {
      return "publication_state";
    }
    if (input.attemptNo !== publication.attempts + 1) return "attempt_mismatch";
    if (!isDueAt(job.available_at, input.now)) return "not_due";
    if (publication.attempts >= PUBLISHER_MAX_ATTEMPTS) return "attempt_budget_exhausted";
    const slot = await this.readOne<CredentialRow>(
      `${SELECT_CREDENTIAL} WHERE platform = ?`,
      publication.platform,
    );
    if ((slot?.revision ?? 0) !== input.credentialSlotRevision) {
      return "credential_revision_mismatch";
    }
    return "publication_state";
  }

  public async commitExecution(input: ExecutionCommit): Promise<CommitResult> {
    const fingerprint = executionCommitFingerprint(input);
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    if (publication === null) {
      return commitConflict("not_found");
    }
    if (publication.committed_outcome_key === input.attemptId) {
      // Only this attempt's own committed identity is a replay. A recorded key
      // from an earlier attempt stays harmless: the SQL guard still requires the
      // current attempt id and claim token.
      return publication.committed_outcome_fingerprint === fingerprint
        ? COMMIT_ALREADY_APPLIED
        : commitConflict("guard_mismatch");
    }
    if (publication.status === "published" || publication.status === "failed") {
      return commitConflict("terminal");
    }

    const marker = this.marker();
    const archiveKey = input.archive?.key ?? null;
    const archiveStatus = input.archive === null ? "not_requested" : "pending";
    const statements: D1PreparedStatement[] = [];

    if (input.outcome === "published") {
      statements.push(
        this.prepare(
            `UPDATE publications
             SET status = 'published', published_at = ?, external_id = ?, external_url = ?,
                 error_code = NULL, error_ambiguous = 0, terminal_reason = NULL,
                 claim_token = NULL, retry_at = NULL, archive_key = ?, archive_status = ?,
                 committed_outcome_key = ?, committed_outcome_fingerprint = ?,
                 updated_at = ?, mutation_marker = ?
             WHERE id = ? AND current_job_id = ? AND attempt_id = ? AND claim_token = ?
               AND status = 'publishing'
               AND (committed_outcome_key IS NULL OR committed_outcome_key <> ?)`,
          )
          .bind(
            input.now,
            input.externalId,
            input.externalUrl,
            archiveKey,
            archiveStatus,
            input.attemptId,
            fingerprint,
            input.now,
            marker,
            input.publicationId,
            input.jobId,
            input.attemptId,
            input.claimToken,
            input.attemptId,
          ),
      );
    } else if (input.outcome === "failed") {
      statements.push(
        this.prepare(
            `UPDATE publications
             SET status = 'failed', terminal_reason = ?, error_code = ?, error_ambiguous = ?,
                 claim_token = NULL, retry_at = NULL, archive_key = ?, archive_status = ?,
                 committed_outcome_key = ?, committed_outcome_fingerprint = ?,
                 updated_at = ?, mutation_marker = ?
             WHERE id = ? AND current_job_id = ? AND attempt_id = ? AND claim_token = ?
               AND status = 'publishing'
               AND (committed_outcome_key IS NULL OR committed_outcome_key <> ?)`,
          )
          .bind(
            input.terminalReason,
            input.errorCode,
            input.errorAmbiguous ? 1 : 0,
            archiveKey,
            archiveStatus,
            input.attemptId,
            fingerprint,
            input.now,
            marker,
            input.publicationId,
            input.jobId,
            input.attemptId,
            input.claimToken,
            input.attemptId,
          ),
      );
    } else {
      if (input.nextJob.aggregateId !== input.publicationId) {
        return commitConflict("guard_mismatch");
      }
      if (input.nextJob.attemptNo !== publication.attempts + 1) {
        return commitConflict("duplicate_attempt");
      }
      if (input.nextJob.availableAt !== input.retryAt) {
        return commitConflict("guard_mismatch");
      }
      if (publication.attempts >= PUBLISHER_MAX_ATTEMPTS) {
        return commitConflict("attempt_budget_exhausted");
      }
      const successor = await this.readOne<{ id: string }>(
        "SELECT id FROM outbox_jobs WHERE id = ?",
        input.nextJob.id,
      );
      if (successor !== null) {
        return commitConflict("guard_mismatch");
      }
      statements.push(
        this.prepare(
            `UPDATE publications
             SET status = 'pending', retry_at = ?, current_job_id = ?, claim_token = NULL,
                 attempt_id = NULL, error_code = ?, error_ambiguous = 0, terminal_reason = NULL,
                 archive_key = ?, archive_status = ?,
                 committed_outcome_key = ?, committed_outcome_fingerprint = ?,
                 updated_at = ?, mutation_marker = ?
             WHERE id = ? AND current_job_id = ? AND attempt_id = ? AND claim_token = ?
               AND status = 'publishing'
               AND (committed_outcome_key IS NULL OR committed_outcome_key <> ?)
               AND attempts < ?`,
          )
          .bind(
            input.retryAt,
            input.nextJob.id,
            input.errorCode,
            archiveKey,
            archiveStatus,
            input.attemptId,
            fingerprint,
            input.now,
            marker,
            input.publicationId,
            input.jobId,
            input.attemptId,
            input.claimToken,
            input.attemptId,
            PUBLISHER_MAX_ATTEMPTS,
          ),
      );
      statements.push(
        this.prepare(
            `INSERT INTO outbox_jobs (id, kind, payload_version, aggregate_id, attempt_no, available_at, status, dispatch_revision, dispatch_attempt_count, created_at, updated_at, recovery_count, mutation_marker)
             SELECT ?, ?, 1, ?, ?, ?, 'pending', 0, 0, ?, ?, 0, ?
             WHERE (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
          )
          .bind(
            input.nextJob.id,
            input.nextJob.kind,
            input.nextJob.aggregateId,
            input.nextJob.attemptNo,
            input.nextJob.availableAt,
            input.now,
            input.now,
            marker,
            input.publicationId,
            marker,
          ),
      );
    }

    statements.push(
      this.prepare(
          `UPDATE outbox_jobs SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND status <> 'cancelled'
             AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
        )
        .bind(input.now, input.jobId, input.publicationId, marker),
      this.prepare(
          `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
           WHERE id = (SELECT post_id FROM publications WHERE id = ?)
             AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
        )
        .bind(input.now, input.publicationId, input.publicationId, marker),
    );

    const results = await this.runBatch("commitExecution", statements);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    const after = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    if (after !== null && after.committed_outcome_key === input.attemptId) {
      return after.committed_outcome_fingerprint === fingerprint
        ? COMMIT_ALREADY_APPLIED
        : commitConflict("guard_mismatch");
    }
    return commitConflict(
      after !== null && (after.status === "published" || after.status === "failed")
        ? "terminal"
        : "guard_mismatch",
    );
  }

  public async rejectBeforeExecution(input: PreExecutionRejection): Promise<CommitResult> {
    const fingerprint = JSON.stringify(["rejected", input.terminalReason, input.errorCode]);
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    if (publication === null) {
      return commitConflict("not_found");
    }
    if (publication.committed_outcome_key === input.jobId) {
      return publication.committed_outcome_fingerprint === fingerprint
        ? COMMIT_ALREADY_APPLIED
        : commitConflict("guard_mismatch");
    }
    if (publication.status === "published" || publication.status === "failed") {
      return commitConflict("terminal");
    }
    if (publication.claim_token !== null) {
      return commitConflict("already_claimed");
    }

    const marker = this.marker();
    const results = await this.runBatch("rejectBeforeExecution", [
      this.prepare(
          `UPDATE publications
           SET status = 'failed', terminal_reason = ?, error_code = ?, error_ambiguous = 0,
               claim_token = NULL, retry_at = NULL,
               committed_outcome_key = ?, committed_outcome_fingerprint = ?,
               updated_at = ?, mutation_marker = ?
           WHERE id = ? AND current_job_id = ? AND claim_token IS NULL
             AND status IN ('pending', 'scheduled')
             AND (committed_outcome_key IS NULL OR committed_outcome_key <> ?)
             AND EXISTS (SELECT 1 FROM outbox_jobs j WHERE j.id = ? AND j.aggregate_id = publications.id AND j.kind = 'delivery.execute')`,
        )
        .bind(
          input.terminalReason,
          input.errorCode,
          input.jobId,
          fingerprint,
          input.now,
          marker,
          input.publicationId,
          input.jobId,
          input.jobId,
          input.jobId,
        ),
      this.prepare(
          `UPDATE outbox_jobs SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
        )
        .bind(input.now, input.jobId, input.publicationId, marker),
      this.prepare(
          `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
           WHERE id = (SELECT post_id FROM publications WHERE id = ?)
             AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
        )
        .bind(input.now, input.publicationId, input.publicationId, marker),
    ]);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    return commitConflict("guard_mismatch");
  }

  public async recoverStaleClaims(input: MaintenanceBudget): Promise<RecoveryResult> {
    requireMaintenanceBudget(input);
    let examined = 0;
    let staleClaimsMarkedUnknown = 0;
    let jobsRearmed = 0;
    let jobsDeadLettered = 0;
    let skipped = 0;
    let remaining = input.limit;

    const staleBefore = new Date(Date.parse(input.now) - STALE_CLAIM_WINDOW_MS).toISOString();
    if (remaining > 0) {
      const stale = await this.readAll<{ id: string; current_job_id: string | null }>(
        `SELECT id, current_job_id FROM publications
         WHERE status = 'publishing' AND publishing_at <= ?
         ORDER BY id LIMIT ?`,
        staleBefore,
        remaining,
      );
      for (const row of stale) {
        examined += 1;
        remaining -= 1;
        const marker = this.marker();
        const results = await this.runBatch("recoverStaleClaim", [
          this.prepare(
              `UPDATE publications
               SET status = 'failed', terminal_reason = 'unknown', error_ambiguous = 1,
                   claim_token = NULL, updated_at = ?, mutation_marker = ?
               WHERE id = ? AND status = 'publishing' AND publishing_at <= ?`,
            )
            .bind(input.now, marker, row.id, staleBefore),
          this.prepare(
              `UPDATE outbox_jobs SET status = 'cancelled', updated_at = ?
               WHERE id = ? AND status <> 'cancelled'
                 AND (SELECT current_job_id FROM publications WHERE id = ? AND mutation_marker = ?) = ?`,
            )
            .bind(
              input.now,
              row.current_job_id ?? "",
              row.id,
              marker,
              row.current_job_id ?? "",
            ),
          this.prepare(
              `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
               WHERE id = (SELECT post_id FROM publications WHERE id = ?)
                 AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
            )
            .bind(input.now, row.id, row.id, marker),
        ]);
        if (D1Repository.changesOf(results, 0) === 1) {
          staleClaimsMarkedUnknown += 1;
        } else {
          skipped += 1;
        }
      }
    }

    if (remaining > 0) {
      const dlqDue = await this.readAll<{ id: string; aggregate_id: string }>(
        `SELECT j.id, j.aggregate_id FROM outbox_jobs j
         JOIN publications p ON p.id = j.aggregate_id
         WHERE j.dlq_seen_at IS NOT NULL AND j.status IN ('pending', 'dispatched')
           AND p.current_job_id = j.id AND p.claim_token IS NULL
           AND p.status IN ('pending', 'scheduled') AND j.available_at <= ?
         ORDER BY j.id LIMIT ?`,
        input.now,
        remaining,
      );
      for (const row of dlqDue) {
        examined += 1;
        remaining -= 1;
        const marker = this.marker();
        const results = await this.runBatch("recoverDlqDue", [
          this.prepare(
              `UPDATE publications
               SET status = 'failed', terminal_reason = 'dead_lettered', error_ambiguous = 0,
                   claim_token = NULL, updated_at = ?, mutation_marker = ?
               WHERE id = ? AND current_job_id = ? AND claim_token IS NULL
                 AND status IN ('pending', 'scheduled')
                 AND EXISTS (SELECT 1 FROM outbox_jobs j
                             WHERE j.id = ? AND j.status IN ('pending', 'dispatched')
                               AND j.dlq_seen_at IS NOT NULL AND j.available_at <= ?
                               AND j.kind = 'delivery.execute' AND j.payload_version = 1)`,
            )
            .bind(input.now, marker, row.aggregate_id, row.id, row.id, input.now),
          this.prepare(
              `UPDATE outbox_jobs SET status = 'cancelled', updated_at = ?
               WHERE id = ? AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
            )
            .bind(input.now, row.id, row.aggregate_id, marker),
          this.prepare(
              `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
               WHERE id = (SELECT post_id FROM publications WHERE id = ?)
                 AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
            )
            .bind(input.now, row.aggregate_id, row.aggregate_id, marker),
        ]);
        if (D1Repository.changesOf(results, 0) === 1) {
          jobsDeadLettered += 1;
        } else {
          skipped += 1;
        }
      }
    }

    if (remaining > 0) {
      const stalled = await this.readAll<{
        id: string;
        aggregate_id: string;
        recovery_count: number;
      }>(
        `SELECT j.id, j.aggregate_id, j.recovery_count FROM outbox_jobs j
         JOIN publications p ON p.id = j.aggregate_id
         WHERE j.status = 'dispatched' AND j.dlq_seen_at IS NULL
           AND j.recovery_after IS NOT NULL AND j.recovery_after <= ?
           AND p.current_job_id = j.id AND p.claim_token IS NULL
           AND p.status IN ('pending', 'scheduled')
         ORDER BY j.id LIMIT ?`,
        input.now,
        remaining,
      );
      for (const row of stalled) {
        examined += 1;
        remaining -= 1;
        if (row.recovery_count >= MAX_STALLED_RECOVERIES) {
          const marker = this.marker();
          const results = await this.runBatch("recoverStalledExhausted", [
            this.prepare(
                `UPDATE publications
                 SET status = 'failed', terminal_reason = 'dead_lettered', error_ambiguous = 0,
                     claim_token = NULL, updated_at = ?, mutation_marker = ?
                 WHERE id = ? AND current_job_id = ? AND claim_token IS NULL
                   AND status IN ('pending', 'scheduled')
                   AND EXISTS (SELECT 1 FROM outbox_jobs j
                               WHERE j.id = ? AND j.status = 'dispatched' AND j.dlq_seen_at IS NULL
                                 AND j.recovery_count >= ? AND j.recovery_after IS NOT NULL
                                 AND j.recovery_after <= ?)`,
              )
              .bind(
                input.now,
                marker,
                row.aggregate_id,
                row.id,
                row.id,
                MAX_STALLED_RECOVERIES,
                input.now,
              ),
            this.prepare(
                `UPDATE outbox_jobs SET status = 'cancelled', transport_reason = 'stalled_recovery_exhausted', updated_at = ?
                 WHERE id = ? AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
              )
              .bind(input.now, row.id, row.aggregate_id, marker),
            this.prepare(
                `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
                 WHERE id = (SELECT post_id FROM publications WHERE id = ?)
                   AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
              )
              .bind(input.now, row.aggregate_id, row.aggregate_id, marker),
          ]);
          if (D1Repository.changesOf(results, 0) === 1) {
            jobsDeadLettered += 1;
          } else {
            skipped += 1;
          }
          continue;
        }
        const results = await this.runBatch("recoverStalledRearm", [
          this.prepare(
              `UPDATE outbox_jobs
               SET status = 'pending', dispatch_revision = dispatch_revision + 1,
                   recovery_count = recovery_count + 1, recovery_after = ?, updated_at = ?
               WHERE id = ? AND status = 'dispatched' AND dlq_seen_at IS NULL
                 AND recovery_after IS NOT NULL AND recovery_after <= ?
                 AND EXISTS (SELECT 1 FROM publications p
                             WHERE p.id = outbox_jobs.aggregate_id AND p.current_job_id = outbox_jobs.id
                               AND p.claim_token IS NULL AND p.status IN ('pending', 'scheduled'))`,
            )
            .bind(
              new Date(Date.parse(input.now) + STALLED_RECOVERY_MIN_WAIT_MS).toISOString(),
              input.now,
              row.id,
              input.now,
            ),
        ]);
        if (D1Repository.changesOf(results, 0) === 1) {
          jobsRearmed += 1;
        } else {
          skipped += 1;
        }
      }
    }

    return Object.freeze({
      examined,
      staleClaimsMarkedUnknown,
      jobsRearmed,
      jobsDeadLettered,
      skipped,
    });
  }

  // -------------------------------------------------------------------------
  // OutboxStore
  // -------------------------------------------------------------------------

  public async listReady(input: ReadyQuery): Promise<readonly OutboxJob[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new InvalidContractInputError("ReadyQuery.limit must be a positive safe integer");
    }
    const rows = await this.readAll<OutboxJobRow>(
      `${SELECT_JOB} WHERE status = 'pending' AND dlq_seen_at IS NULL AND available_at <= ?
       AND kind = 'delivery.execute' AND payload_version = 1
       ORDER BY available_at, id LIMIT ?`,
      input.now,
      input.limit,
    );
    return Object.freeze(rows.map(toOutboxJob));
  }

  public async recordDispatch(input: DispatchObservation): Promise<CommitResult> {
    const dispatched = input.outcome.kind === "dispatched";
    const failureCode = input.outcome.kind === "failed" ? input.outcome.errorCode : null;
    const results = await this.runBatch("recordDispatch", [
      this.prepare(
          `UPDATE outbox_jobs
           SET status = CASE WHEN ? = 1 THEN 'dispatched' ELSE status END,
               dispatched_at = CASE WHEN ? = 1 THEN ? ELSE dispatched_at END,
               recovery_after = CASE WHEN ? = 1 THEN ? ELSE recovery_after END,
               dispatch_attempt_count = dispatch_attempt_count + 1,
               last_dispatch_error_code = ?,
               updated_at = ?
           WHERE id = ? AND dispatch_revision = ? AND status = 'pending' AND dlq_seen_at IS NULL`,
        )
        .bind(
          dispatched ? 1 : 0,
          dispatched ? 1 : 0,
          input.now,
          dispatched ? 1 : 0,
          new Date(Date.parse(input.now) + STALLED_RECOVERY_MIN_WAIT_MS).toISOString(),
          failureCode,
          input.now,
          input.jobId,
          input.dispatchRevision,
        ),
    ]);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    const job = await this.readOne<OutboxJobRow>(`${SELECT_JOB} WHERE id = ?`, input.jobId);
    if (job === null) return commitConflict("not_found");
    if (job.dlq_seen_at !== null) return commitConflict("guard_mismatch");
    if (job.dispatch_revision !== input.dispatchRevision) return commitConflict("revision_mismatch");
    if (job.status === "cancelled") return commitConflict("terminal");
    return commitConflict("guard_mismatch");
  }

  public async rearmCurrentJob(input: RearmCondition): Promise<RearmResult> {
    const stalled = input.reason === "stalled_transport";
    const results = stalled
      ? await this.runBatch("rearmCurrentJob", [
          this.prepare(
              `UPDATE outbox_jobs
               SET status = 'pending', dispatch_revision = dispatch_revision + 1,
                   recovery_count = recovery_count + 1, recovery_after = ?, updated_at = ?
               WHERE id = ? AND dlq_seen_at IS NULL AND status = 'dispatched'
                 AND recovery_after IS NOT NULL AND recovery_after <= ? AND recovery_count < ?
                 AND EXISTS (SELECT 1 FROM publications p
                             WHERE p.id = ? AND p.current_job_id = outbox_jobs.id
                               AND p.claim_token IS NULL AND p.status IN ('pending', 'scheduled'))`,
            )
            .bind(
              new Date(Date.parse(input.now) + STALLED_RECOVERY_MIN_WAIT_MS).toISOString(),
              input.now,
              input.jobId,
              input.now,
              MAX_STALLED_RECOVERIES,
              input.publicationId,
            ),
        ])
      : await this.runBatch("rearmCurrentJob", [
          this.prepare(
              `UPDATE outbox_jobs
               SET status = 'pending', dispatch_revision = dispatch_revision + 1, updated_at = ?
               WHERE id = ? AND dlq_seen_at IS NULL AND status = 'dispatched'
                 AND EXISTS (SELECT 1 FROM publications p
                             WHERE p.id = ? AND p.current_job_id = outbox_jobs.id
                               AND p.claim_token IS NULL AND p.status IN ('pending', 'scheduled'))`,
            )
            .bind(input.now, input.jobId, input.publicationId),
        ]);

    if (D1Repository.changesOf(results, 0) === 1) {
      const job = await this.readOne<OutboxJobRow>(`${SELECT_JOB} WHERE id = ?`, input.jobId);
      return Object.freeze({
        kind: "rearmed" as const,
        recoveryCount: job?.recovery_count ?? 0,
        dispatchRevision: job?.dispatch_revision ?? 0,
      });
    }
    const job = await this.readOne<OutboxJobRow>(`${SELECT_JOB} WHERE id = ?`, input.jobId);
    if (job === null) {
      return Object.freeze({ kind: "conflict" as const, reason: "not_found" as const });
    }
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    if (publication === null || publication.current_job_id !== job.id) {
      return Object.freeze({ kind: "conflict" as const, reason: "not_current_job" as const });
    }
    if (
      publication.status === "published" ||
      publication.status === "failed" ||
      job.status === "cancelled"
    ) {
      return Object.freeze({ kind: "conflict" as const, reason: "terminal" as const });
    }
    if (publication.claim_token !== null) {
      return Object.freeze({ kind: "conflict" as const, reason: "active_claim" as const });
    }
    if (job.dlq_seen_at !== null) {
      return Object.freeze({ kind: "conflict" as const, reason: "dlq_seen" as const });
    }
    if (stalled && job.recovery_count >= MAX_STALLED_RECOVERIES) {
      return Object.freeze({ kind: "exhausted" as const, recoveryCount: job.recovery_count });
    }
    if (stalled && (job.recovery_after === null || !isDueAt(job.recovery_after, input.now))) {
      return Object.freeze({ kind: "conflict" as const, reason: "not_due" as const });
    }
    if (job.status === "pending") {
      return Object.freeze({
        kind: "rearmed" as const,
        recoveryCount: job.recovery_count,
        dispatchRevision: job.dispatch_revision,
      });
    }
    return Object.freeze({ kind: "conflict" as const, reason: "revision_mismatch" as const });
  }

  public async collectFinished(input: MaintenanceBudget): Promise<CleanupResult> {
    requireMaintenanceBudget(input);
    const retentionBefore = new Date(
      Date.parse(input.now) - OUTBOX_FINISHED_RETENTION_MS,
    ).toISOString();
    const results = await this.runBatch("collectFinished", [
      this.prepare(
          `DELETE FROM outbox_jobs
           WHERE id IN (
             SELECT j.id FROM outbox_jobs j
             JOIN publications p ON p.id = j.aggregate_id
             WHERE j.status = 'cancelled' AND p.status IN ('published', 'failed')
               AND NOT (p.status = 'failed' AND (p.error_ambiguous = 1 OR p.terminal_reason = 'unknown'))
               AND j.updated_at <= ?
             ORDER BY j.id LIMIT ?
           )`,
        )
        .bind(retentionBefore, input.limit),
    ]);
    return Object.freeze({ removed: D1Repository.changesOf(results, 0) });
  }

  // -------------------------------------------------------------------------
  // CredentialStore
  // -------------------------------------------------------------------------

  public async readSlot(input: { readonly platform: Platform }) {
    const row = await this.readOne<CredentialRow>(
      `${SELECT_CREDENTIAL} WHERE platform = ?`,
      input.platform,
    );
    return toSlotSnapshot(row, input.platform);
  }

  public async compareAndSetSlot(input: SlotMutation): Promise<SlotMutationResult> {
    const change = input.change;
    const removing = change.kind === "remove";
    const envelope = removing ? null : JSON.stringify(change.envelope);
    const bindingId = removing ? null : change.bindingId;
    const payloadRevision = removing ? null : change.payloadRevision;
    const payloadSchemaVersion = removing ? null : change.payloadSchemaVersion;
    const expiresAt = removing ? null : change.expiresAt;
    const targetLabel = removing ? null : (change.target?.label ?? null);
    const targetSource = removing ? null : (change.target?.source ?? null);

    const results = await this.runBatch("compareAndSetSlot", [
      this.prepare(
          `UPDATE credentials
           SET revision = revision + 1, tombstone = ?, envelope = ?, data = '{}',
               binding_id = ?, payload_revision = ?, payload_schema_version = ?, expires_at = ?,
               target_label = ?, target_source = ?, refresh_state = 'ready',
               refresh_lease_token = NULL, refresh_lease_acquired_at = NULL,
               refresh_lease_expires_at = NULL, refresh_lease_revision = NULL,
               last_refresh_commit_fingerprint = NULL, updated_at = ?
           WHERE platform = ? AND revision = ?`,
        )
        .bind(
          removing ? 1 : 0,
          envelope,
          bindingId,
          payloadRevision,
          payloadSchemaVersion,
          expiresAt,
          targetLabel,
          targetSource,
          input.now,
          input.platform,
          input.expectedRevision,
        ),
      this.prepare(
          `INSERT INTO credentials (platform, data, created_at, updated_at, expires_at, revision, binding_id, tombstone, payload_revision, payload_schema_version, envelope, target_label, target_source, refresh_state)
           SELECT ?, '{}', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'ready'
           WHERE ? = 0 AND NOT EXISTS (SELECT 1 FROM credentials WHERE platform = ?)`,
        )
        .bind(
          input.platform,
          input.now,
          input.now,
          expiresAt,
          bindingId,
          removing ? 1 : 0,
          payloadRevision,
          payloadSchemaVersion,
          envelope,
          targetLabel,
          targetSource,
          input.expectedRevision,
          input.platform,
        ),
    ]);
    const changes =
      D1Repository.changesOf(results, 0) + D1Repository.changesOf(results, 1);
    if (changes === 1) {
      // CAS revision is derived from the caller's own expected revision, never
      // from a later read that another writer may already have advanced.
      return Object.freeze({ kind: "applied" as const, revision: input.expectedRevision + 1 });
    }
    return Object.freeze({ kind: "conflict" as const, reason: "revision_mismatch" as const });
  }

  public async createAuthOperation(input: AuthOperationStart): Promise<void> {
    let results: D1Result[];
    try {
      results = await this.runBatch("createAuthOperation", [
        this.prepare(
            `INSERT INTO oauth_state (state, platform, data, expires_at, created_at, operation_id, phase, expected_revision, canonical_callback_url, start_config_binding, request_token, request_secret_envelope, request_secret_purpose, request_secret_revision, missing_fields, updated_at)
             SELECT ?, ?, '{}', ?, ?, ?, 'pending_callback', ?, ?, ?, ?, ?, ?, ?, '[]', ?
             WHERE NOT EXISTS (SELECT 1 FROM oauth_state WHERE operation_id = ?)
               AND NOT EXISTS (SELECT 1 FROM oauth_state WHERE platform = ? AND state = ?)`,
          )
          .bind(
            input.oauthState,
            input.platform,
            input.expiresAt,
            input.now,
            input.operationId,
            input.expectedRevision,
            input.canonicalCallbackUrl,
            input.startConfigBinding,
            input.requestToken,
            input.requestSecret === null ? null : JSON.stringify(input.requestSecret),
            input.requestSecretPurpose,
            input.requestSecretRevision,
            input.now,
            input.operationId,
            input.platform,
            input.oauthState,
          ),
      ]);
    } catch (error) {
      // Infrastructure failure is not a duplicate: never report it as one.
      throw storageFailure("createAuthOperation", error);
    }
    if (D1Repository.changesOf(results, 0) !== 1) {
      throw new InvalidContractInputError("auth operation already exists");
    }
    const created = await this.readOne<OAuthOperationRow>(
      `${SELECT_OPERATION} WHERE operation_id = ?`,
      input.operationId,
    );
    if (created === null) {
      throw new CorruptStoreRecordError("operation insert reported success without a row");
    }
  }

  public async findAuthOperationByState(input: {
    readonly platform: Platform;
    readonly oauthState: string;
  }): Promise<StoredAuthOperation | null> {
    const row = await this.readOne<OAuthOperationRow>(
      `${SELECT_OPERATION} WHERE platform = ? AND state = ? AND operation_id IS NOT NULL LIMIT 1`,
      input.platform,
      input.oauthState,
    );
    return row === null ? null : toStoredAuthOperation(row);
  }

  public async claimOAuthCallback(input: OAuthClaim): Promise<OAuthClaimResult> {
    const before = await this.findAuthOperationByState({
      platform: input.platform,
      oauthState: input.oauthState,
    });
    if (before === null) {
      return Object.freeze({ kind: "conflict" as const, reason: "not_found" as const });
    }
    const marker = this.marker();
    let results: D1Result[];
    try {
      results = await this.runBatch("claimOAuthCallback", [
        this.prepare(
            `UPDATE oauth_state
             SET phase = 'exchanging', updated_at = ?, mutation_marker = ?
             WHERE platform = ? AND state = ? AND operation_id IS NOT NULL
               AND operation_id = ?
               AND phase = 'pending_callback' AND expires_at > ? AND start_config_binding = ?
               AND (request_token IS NULL OR request_token = ?)`,
          )
          .bind(
            input.now,
            marker,
            input.platform,
            input.oauthState,
            before.operationId,
            input.now,
            input.currentConfigBinding,
            input.requestToken,
          ),
      ]);
    } catch {
      // Lost acknowledgement: exactly one winner may exist and this caller
      // cannot prove it is that winner, so no exchange is authorised.
      return Object.freeze({ kind: "unknown" as const });
    }
    if (D1Repository.changesOf(results, 0) !== 1) {
      return Object.freeze({
        kind: "conflict" as const,
        reason: await this.explainOAuthClaimBlock(input),
      });
    }
    // Report the phase this invocation set, not whatever a later read sees.
    return Object.freeze({
      kind: "claimed" as const,
      operation: Object.freeze({ ...before, phase: "exchanging", updatedAt: input.now }),
    });
  }

  private async explainOAuthClaimBlock(input: OAuthClaim) {
    const row = await this.readOne<OAuthOperationRow>(
      `${SELECT_OPERATION} WHERE platform = ? AND state = ? AND operation_id IS NOT NULL LIMIT 1`,
      input.platform,
      input.oauthState,
    );
    if (row === null) return "not_found" as const;
    if (row.phase !== "pending_callback") return "phase_mismatch" as const;
    if (!(row.expires_at > input.now)) return "expired" as const;
    if (row.start_config_binding !== input.currentConfigBinding) {
      return "start_config_changed" as const;
    }
    if (row.request_token !== null && row.request_token !== input.requestToken) {
      return "request_token_mismatch" as const;
    }
    return "phase_mismatch" as const;
  }

  public async saveCandidate(input: CandidateCommit): Promise<CommitResult> {
    const candidate = input.outcome.kind === "candidate" ? input.outcome : null;
    const failureCode = input.outcome.kind === "failed" ? input.outcome.errorCode : null;
    const results = await this.runBatch("saveCandidate", [
      this.prepare(
          `UPDATE oauth_state
           SET phase = ?, candidate_envelope = ?, candidate_payload_revision = ?,
               candidate_payload_schema_version = ?, candidate_target_label = ?, candidate_target_source = ?,
               missing_fields = ?, error_code = ?,
               request_secret_envelope = NULL, request_secret_purpose = NULL, request_secret_revision = NULL,
               updated_at = ?
           WHERE operation_id = ? AND platform = ? AND phase = 'exchanging' AND expires_at > ?`,
        )
        .bind(
          candidate === null ? "failed" : candidate.phase,
          candidate === null ? null : JSON.stringify(candidate.candidateEnvelope),
          candidate?.candidatePayloadRevision ?? null,
          candidate?.candidatePayloadSchemaVersion ?? null,
          candidate?.candidateTarget?.label ?? null,
          candidate?.candidateTarget?.source ?? null,
          JSON.stringify(candidate?.missingFields ?? []),
          failureCode,
          input.now,
          input.operationId,
          input.platform,
          input.now,
        ),
    ]);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    const row = await this.readOne<OAuthOperationRow>(
      `${SELECT_OPERATION} WHERE operation_id = ?`,
      input.operationId,
    );
    if (row === null) return commitConflict("not_found");
    if (!(row.expires_at > input.now)) return commitConflict("operation_expired");
    return commitConflict("phase_mismatch");
  }

  public async activateCandidate(input: ActivationCommit): Promise<ActivationResult> {
    const row = await this.readOne<OAuthOperationRow>(
      `${SELECT_OPERATION} WHERE operation_id = ?`,
      input.operationId,
    );
    if (row === null) {
      return Object.freeze({ kind: "conflict" as const, reason: "not_found" as const });
    }
    if (row.platform !== input.platform) {
      return Object.freeze({ kind: "conflict" as const, reason: "platform_mismatch" as const });
    }
    if (row.phase === "completed" && row.receipt !== null) {
      const receipt = JSON.parse(row.receipt) as {
        readonly revision: number;
      };
      return Object.freeze({
        kind: "replayed" as const,
        revision: receipt.revision,
        receipt: Object.freeze({ ...receipt, replayed: true }) as never,
      });
    }
    if (row.phase !== "awaiting_confirmation" && row.phase !== "needs_configuration") {
      return Object.freeze({ kind: "conflict" as const, reason: "phase_mismatch" as const });
    }
    if (!(row.expires_at > input.now)) {
      return Object.freeze({ kind: "conflict" as const, reason: "operation_expired" as const });
    }
    if (row.start_config_binding !== input.currentConfigBinding) {
      return Object.freeze({ kind: "conflict" as const, reason: "start_config_changed" as const });
    }
    if (row.phase === "needs_configuration" && input.target === null) {
      return Object.freeze({ kind: "conflict" as const, reason: "target_required" as const });
    }
    if (input.expectedRevision !== row.expected_revision) {
      return Object.freeze({ kind: "conflict" as const, reason: "revision_mismatch" as const });
    }

    const marker = this.marker();
    const receipt = {
      ...input.receipt,
      platform: input.platform,
      operationId: input.operationId,
      revision: input.expectedRevision + 1,
    };
    const results = await this.runBatch("activateCandidate", [
      this.prepare(
          `UPDATE oauth_state
           SET phase = 'completed', receipt = ?, candidate_envelope = NULL,
               candidate_payload_revision = NULL, candidate_payload_schema_version = NULL,
               missing_fields = '[]', error_code = NULL, updated_at = ?, mutation_marker = ?
           WHERE operation_id = ? AND platform = ?
             AND phase IN ('awaiting_confirmation', 'needs_configuration')
             AND expires_at > ? AND expected_revision = ? AND start_config_binding = ?
             AND COALESCE((SELECT revision FROM credentials WHERE platform = ?), 0) = ?`,
        )
        .bind(
          JSON.stringify(receipt),
          input.now,
          marker,
          input.operationId,
          input.platform,
          input.now,
          input.expectedRevision,
          input.currentConfigBinding,
          input.platform,
          input.expectedRevision,
        ),
      this.prepare(
          `UPDATE credentials
           SET revision = revision + 1, tombstone = 0, envelope = ?, binding_id = ?,
               payload_revision = ?, payload_schema_version = ?, expires_at = ?,
               target_label = ?, target_source = ?, refresh_state = 'ready',
               refresh_lease_token = NULL, refresh_lease_acquired_at = NULL,
               refresh_lease_expires_at = NULL, refresh_lease_revision = NULL,
               last_refresh_commit_fingerprint = NULL, data = '{}', updated_at = ?
           WHERE platform = ? AND revision = ? AND (SELECT mutation_marker FROM oauth_state WHERE operation_id = ?) = ?`,
        )
        .bind(
          JSON.stringify(input.envelope),
          input.bindingId,
          input.payloadRevision,
          input.payloadSchemaVersion,
          input.expiresAt,
          input.target?.label ?? null,
          input.target?.source ?? null,
          input.now,
          input.platform,
          input.expectedRevision,
          input.operationId,
          marker,
        ),
      this.prepare(
          `INSERT INTO credentials (platform, data, created_at, updated_at, expires_at, revision, binding_id, tombstone, payload_revision, payload_schema_version, envelope, target_label, target_source, refresh_state)
           SELECT ?, '{}', ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, 'ready'
           WHERE ? = 0
             AND (SELECT mutation_marker FROM oauth_state WHERE operation_id = ?) = ?
             AND NOT EXISTS (SELECT 1 FROM credentials WHERE platform = ?)`,
        )
        .bind(
          input.platform,
          input.now,
          input.now,
          input.expiresAt,
          input.bindingId,
          input.payloadRevision,
          input.payloadSchemaVersion,
          JSON.stringify(input.envelope),
          input.target?.label ?? null,
          input.target?.source ?? null,
          input.expectedRevision,
          input.operationId,
          marker,
          input.platform,
        ),
    ]);
    const slotChanges =
      D1Repository.changesOf(results, 1) + D1Repository.changesOf(results, 2);
    if (D1Repository.changesOf(results, 0) !== 1 || slotChanges !== 1) {
      const after = await this.readOne<OAuthOperationRow>(
        `${SELECT_OPERATION} WHERE operation_id = ?`,
        input.operationId,
      );
      if (after !== null && after.phase === "completed" && after.receipt !== null) {
        const stored = JSON.parse(after.receipt) as { readonly revision: number };
        return Object.freeze({
          kind: "replayed" as const,
          revision: stored.revision,
          receipt: Object.freeze({ ...stored, replayed: true }) as never,
        });
      }
      return Object.freeze({ kind: "conflict" as const, reason: "revision_mismatch" as const });
    }
    return Object.freeze({
      kind: "activated" as const,
      // The caller's own expected revision plus its own atomic bump.
      revision: input.expectedRevision + 1,
      receipt: Object.freeze({ ...receipt }) as never,
    });
  }

  public async acquireRefresh(input: RefreshClaim): Promise<RefreshClaimResult> {
    const slot = await this.readSlot({ platform: input.platform });
    // The response snapshot is built from this pre-read, so refuse to mutate
    // when it does not describe the row the guarded UPDATE will target.
    if (slot.status === "empty") {
      return Object.freeze({ kind: "conflict" as const, reason: "not_found" as const });
    }
    if (slot.status === "tombstone") {
      return Object.freeze({ kind: "conflict" as const, reason: "tombstone" as const });
    }
    if (slot.refreshState === "reconnect_required") {
      return Object.freeze({
        kind: "conflict" as const,
        reason: "reconnect_required" as const,
      });
    }
    if (slot.refreshLease !== null) {
      return Object.freeze({
        kind: "conflict" as const,
        reason: isDueAt(slot.refreshLease.expiresAt, input.now)
          ? ("reconnect_required" as const)
          : ("lease_held" as const),
      });
    }
    if (slot.revision !== input.expectedRevision) {
      return Object.freeze({ kind: "conflict" as const, reason: "revision_mismatch" as const });
    }
    if (slot.envelope === null) {
      return Object.freeze({ kind: "conflict" as const, reason: "no_refresh_payload" as const });
    }
    let results: D1Result[];
    try {
      results = await this.runBatch("acquireRefresh", [
        this.prepare(
            `UPDATE credentials
             SET refresh_lease_token = ?, refresh_lease_acquired_at = ?, refresh_lease_expires_at = ?,
                 refresh_lease_revision = revision, updated_at = ?
             WHERE platform = ? AND revision = ? AND tombstone = 0 AND refresh_state = 'ready'
               AND envelope IS NOT NULL AND refresh_lease_token IS NULL`,
          )
          .bind(
            input.leaseToken,
            input.now,
            new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString(),
            input.now,
            input.platform,
            input.expectedRevision,
          ),
      ]);
    } catch {
      // The lease write acknowledgement was lost. The caller must not exchange:
      // it cannot know whether its own lease or another caller's is live.
      return Object.freeze({ kind: "unknown" as const });
    }
    if (D1Repository.changesOf(results, 0) === 1) {
      // Return this invocation's own lease, never a lease another writer could
      // have installed before a post-batch read.
      const lease = Object.freeze({
        token: input.leaseToken,
        acquiredAt: input.now,
        expiresAt: new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString(),
        revision: input.expectedRevision,
      });
      return Object.freeze({
        kind: "acquired" as const,
        snapshot: Object.freeze({ ...slot, refreshLease: lease, updatedAt: input.now }),
        lease,
      });
    }
    // Unreachable: every non-mutating outcome was decided by the pre-read guard
    // above. Kept explicit for exhaustiveness.
    return Object.freeze({ kind: "conflict" as const, reason: "revision_mismatch" as const });
  }

  public async completeRefresh(input: RefreshCommit): Promise<CommitResult> {
    const fingerprint = refreshCommitFingerprint(input);
    const hasTarget = input.target === null ? 0 : 1;
    const results = await this.runBatch("completeRefresh", [
      this.prepare(
          `UPDATE credentials
           SET revision = revision + 1, envelope = ?, payload_revision = ?, payload_schema_version = ?,
               expires_at = ?, refresh_lease_token = NULL, refresh_lease_acquired_at = NULL,
               refresh_lease_expires_at = NULL, refresh_lease_revision = NULL,
               refresh_state = 'ready', last_refresh_commit_fingerprint = ?, updated_at = ?
           WHERE platform = ? AND revision = ? AND tombstone = 0 AND envelope IS NOT NULL
             AND refresh_lease_token = ? AND refresh_lease_expires_at > ?
             AND (? = 0 OR (target_label = ? AND target_source = ?))`,
        )
        .bind(
          JSON.stringify(input.envelope),
          input.payloadRevision,
          input.payloadSchemaVersion,
          input.expiresAt,
          fingerprint,
          input.now,
          input.platform,
          input.expectedRevision,
          input.leaseToken,
          input.now,
          hasTarget,
          input.target?.label ?? null,
          input.target?.source ?? null,
        ),
    ]);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    const slot = await this.readSlot({ platform: input.platform });
    if (slot.revision === input.expectedRevision + 1 && slot.lastRefreshCommitFingerprint === fingerprint) {
      return COMMIT_ALREADY_APPLIED;
    }
    if (slot.revision !== input.expectedRevision) {
      return commitConflict("revision_mismatch");
    }
    if (slot.refreshLease !== null && isDueAt(slot.refreshLease.expiresAt, input.now)) {
      return commitConflict("reconnect_required");
    }
    if (slot.refreshLease === null || slot.refreshLease.token !== input.leaseToken) {
      return commitConflict("lease_mismatch");
    }
    return commitConflict("guard_mismatch");
  }

  public async markReconnectRequired(input: RefreshFailure): Promise<CommitResult> {
    const results = await this.runBatch("markReconnectRequired", [
      this.prepare(
          `UPDATE credentials
           SET refresh_state = 'reconnect_required', refresh_lease_token = NULL,
               refresh_lease_acquired_at = NULL, refresh_lease_expires_at = NULL,
               refresh_lease_revision = NULL, updated_at = ?
           WHERE platform = ? AND revision = ? AND tombstone = 0 AND refresh_lease_token = ?`,
        )
        .bind(input.now, input.platform, input.expectedRevision, input.leaseToken),
    ]);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    const slot = await this.readSlot({ platform: input.platform });
    if (slot.status === "empty") return commitConflict("not_found");
    if (slot.status === "tombstone") return commitConflict("terminal");
    // Match the portable contract: a failure must belong to the lease that
    // actually failed, so a stale token reports a lease conflict even when the
    // slot revision has also moved on.
    if (slot.refreshLease === null || slot.refreshLease.token !== input.leaseToken) {
      return commitConflict("lease_mismatch");
    }
    if (slot.revision !== input.expectedRevision) return commitConflict("revision_mismatch");
    return commitConflict("lease_mismatch");
  }

  public async readAuthOperation(input: {
    readonly operationId: string;
  }): Promise<StoredAuthOperation | null> {
    const row = await this.readOne<OAuthOperationRow>(
      `${SELECT_OPERATION} WHERE operation_id = ?`,
      input.operationId,
    );
    return row === null ? null : toStoredAuthOperation(row);
  }

  public async cleanupExpired(input: MaintenanceBudget): Promise<CleanupResult> {
    requireMaintenanceBudget(input);
    const results = await this.runBatch("cleanupExpired", [
      this.prepare(
          `UPDATE oauth_state
           SET phase = CASE WHEN phase IN ('completed', 'failed', 'expired') THEN phase ELSE 'expired' END,
               request_secret_envelope = NULL, request_secret_purpose = NULL, request_secret_revision = NULL,
               candidate_envelope = NULL, candidate_payload_revision = NULL, candidate_payload_schema_version = NULL,
               updated_at = ?
           WHERE operation_id IN (
             SELECT operation_id FROM oauth_state
             WHERE operation_id IS NOT NULL AND expires_at <= ?
               AND (phase IS NULL OR phase NOT IN ('completed', 'failed', 'expired')
                    OR request_secret_envelope IS NOT NULL OR candidate_envelope IS NOT NULL)
             ORDER BY operation_id LIMIT ?
           )`,
        )
        .bind(input.now, input.now, input.limit),
    ]);
    return Object.freeze({ removed: D1Repository.changesOf(results, 0) });
  }

  // -------------------------------------------------------------------------
  // DiagnosticsReader
  // -------------------------------------------------------------------------

  public async readSnapshot(): Promise<SafeDiagnostics> {
    const now = this.now();
    const pending = await this.readOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM outbox_jobs WHERE status = 'pending'",
    );
    const oldest = await this.readOne<{ oldest: string | null }>(
      `SELECT MIN(available_at) AS oldest FROM outbox_jobs
       WHERE status = 'pending' AND dlq_seen_at IS NULL AND available_at <= ?`,
      now,
    );
    const retryScheduled = await this.readOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM publications WHERE status = 'pending' AND retry_at IS NOT NULL",
    );
    const deadLettered = await this.readOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM publications WHERE status = 'failed' AND terminal_reason = 'dead_lettered'`,
    );
    const dueDlq = await this.readOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM publications p
       JOIN outbox_jobs j ON j.id = p.current_job_id
       WHERE p.status IN ('pending', 'scheduled') AND j.dlq_seen_at IS NOT NULL`,
    );
    const archiveFailures = await this.readOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM publications WHERE archive_status = 'failed'",
    );
    const oldestAt = oldest?.oldest ?? null;
    return Object.freeze({
      observedAt: now,
      pendingOutbox: pending?.count ?? 0,
      oldestDueAt: oldestAt,
      oldestAgeSeconds:
        oldestAt === null ? null : Math.max(0, Math.floor((Date.parse(now) - Date.parse(oldestAt)) / 1000)),
      retryScheduled: retryScheduled?.count ?? 0,
      deadLettered: (deadLettered?.count ?? 0) + (dueDlq?.count ?? 0),
      latestAttemptArchiveFailures: archiveFailures?.count ?? 0,
      storage: Object.freeze({
        approximateBytes: null,
        limitBytes: null,
        utilization: null,
        reason: "size_unavailable",
        observedAt: now,
      }),
    });
  }

  public async settleDeadLetter(input: DeadLetterCondition): Promise<DeadLetterOutcome> {
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    const job = await this.readOne<OutboxJobRow>(`${SELECT_JOB} WHERE id = ?`, input.jobId);
    if (publication === null || job === null) {
      return Object.freeze({ kind: "not_found" as const });
    }
    if (job.aggregate_id !== input.publicationId) {
      // Malformed cross-entity message: never write metadata before the pair is
      // proven, or it would poison another publication's job.
      return Object.freeze({ kind: "recorded" as const, reason: "not_current_job" as const });
    }

    const marker = this.marker();
    const staleBefore = new Date(Date.parse(input.now) - STALE_CLAIM_WINDOW_MS).toISOString();
    try {
      await this.runBatch("settleDeadLetter", [
        this.prepare(
            `UPDATE outbox_jobs SET dlq_seen_at = ?, transport_reason = ?, updated_at = ?, mutation_marker = ?
             WHERE id = ? AND aggregate_id = ?`,
          )
          .bind(
            input.now,
            input.transportReason,
            input.now,
            marker,
            input.jobId,
            input.publicationId,
          ),
        this.prepare(
            `UPDATE publications
             SET status = 'failed', terminal_reason = 'dead_lettered', error_ambiguous = 0,
                 claim_token = NULL, updated_at = ?, mutation_marker = ?
             WHERE id = ? AND current_job_id = ? AND claim_token IS NULL
               AND status IN ('pending', 'scheduled')
               AND (SELECT mutation_marker FROM outbox_jobs WHERE id = ?) = ?
               AND EXISTS (SELECT 1 FROM outbox_jobs j WHERE j.id = ? AND j.available_at <= ?)`,
          )
          .bind(
            input.now,
            marker,
            input.publicationId,
            input.jobId,
            input.jobId,
            marker,
            input.jobId,
            input.now,
          ),
        this.prepare(
          `UPDATE publications
           SET status = 'failed', terminal_reason = 'unknown', error_ambiguous = 1,
               claim_token = NULL, updated_at = ?, mutation_marker = ?
           WHERE id = ? AND current_job_id = ? AND status = 'publishing' AND publishing_at <= ?
             AND (SELECT mutation_marker FROM outbox_jobs WHERE id = ?) = ?`,
        )
        .bind(
          input.now,
          marker,
          input.publicationId,
          input.jobId,
          staleBefore,
          input.jobId,
          marker,
        ),
        this.prepare(
            `UPDATE outbox_jobs SET status = 'cancelled', updated_at = ?
             WHERE id = ? AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
          )
          .bind(input.now, input.jobId, input.publicationId, marker),
        this.prepare(
            `UPDATE posts SET status = ${POST_AGGREGATE_SQL}, updated_at = ?
             WHERE id = (SELECT post_id FROM publications WHERE id = ?)
               AND (SELECT mutation_marker FROM publications WHERE id = ?) = ?`,
          )
          .bind(input.now, input.publicationId, input.publicationId, marker),
      ]);
    } catch {
      // Metadata could not be committed: the runtime must not acknowledge.
      throw new StoreUnavailable("dead-letter settlement failed");
    }

    const after = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    if (after === null) {
      return Object.freeze({ kind: "not_found" as const });
    }
    if (after.terminal_reason === "dead_lettered") {
      return Object.freeze({ kind: "dead_lettered" as const, attempts: after.attempts });
    }
    if (after.terminal_reason === "unknown" && publication.terminal_reason !== "unknown") {
      return Object.freeze({ kind: "recovered_unknown" as const, attempts: after.attempts });
    }
    if (after.status === "published" || after.status === "failed") {
      return Object.freeze({ kind: "recorded" as const, reason: "terminal" as const });
    }
    if (after.status === "publishing") {
      return Object.freeze({ kind: "recorded" as const, reason: "active_claim" as const });
    }
    if (after.current_job_id !== input.jobId) {
      return Object.freeze({ kind: "recorded" as const, reason: "not_current_job" as const });
    }
    return Object.freeze({ kind: "recorded" as const, reason: "not_due" as const });
  }

  public async recordArchiveResult(input: ArchiveResultCommit): Promise<CommitResult> {
    const results = await this.runBatch("recordArchiveResult", [
      this.prepare(
          `UPDATE publications SET archive_status = ?, updated_at = ?
           WHERE id = ? AND archive_key = ?
             AND archive_status <> ?
             AND ((attempt_id IS NOT NULL AND attempt_id = ?)
               OR (attempt_id IS NULL AND committed_outcome_key = ?))`,
        )
        .bind(
          input.status,
          input.now,
          input.publicationId,
          input.archiveKey,
          input.status,
          input.attemptId,
          input.attemptId,
        ),
    ]);
    if (D1Repository.changesOf(results, 0) === 1) {
      return COMMIT_APPLIED;
    }
    const publication = await this.readOne<PublicationRow>(
      `${SELECT_PUBLICATION} WHERE id = ?`,
      input.publicationId,
    );
    if (publication === null) {
      return commitConflict("not_found");
    }
    const identity = publication.attempt_id ?? publication.committed_outcome_key ?? null;
    if (
      identity === input.attemptId &&
      publication.archive_key === input.archiveKey &&
      publication.archive_status === input.status
    ) {
      return COMMIT_ALREADY_APPLIED;
    }
    return commitConflict("guard_mismatch");
  }
}

function commitCreateConflict(
  reason: "credential_revision_mismatch" | "duplicate_publication" | "duplicate_job",
): CreateCommitResult {
  return Object.freeze({ kind: "conflict" as const, reason });
}

/**
 * Fixed, payload-free storage failure.
 *
 * Raw D1 errors can embed SQL text, bound parameters and secret values, so the
 * adapter never forwards them (or their `cause` chain) to callers. `op` is one
 * of this module's own literal labels.
 */
function storageFailure(op: string, _error: unknown): StoreUnavailable {
  return new StoreUnavailable(`storage operation failed: ${op}`);
}
