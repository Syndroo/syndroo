/**
 * Portable create use case.
 *
 * Order matters and is part of the contract:
 *
 * 1. Snapshot the caller's intent (no `await` before the copy is taken).
 * 2. Reject structurally invalid input and a malformed idempotency key.
 * 3. Answer an existing idempotency record before preparation, signing or any
 *    configuration check, so a replay survives missing credentials.
 * 4. Prepare every platform and sign its connection binding before the write.
 * 5. Commit Post + Publications + initial outbox jobs atomically with the
 *    credential revision/slot guards.
 * 6. Run the shared dispatcher as an optional fast path for immediate work.
 *    A replay and a future-scheduled create skip it entirely, and a fast-path
 *    failure is reported — never rolled back — because the outbox already
 *    holds the intent.
 */

import type { CreatePostInput, Platform, PostStatus } from "@syndroo/core";

import { computeCredentialBinding, type BindingSigner } from "../contracts/binding.js";
import {
  CREATE_POST_SCOPE,
  canonicalCreateRequestFingerprint,
} from "../contracts/idempotency.js";
import type {
  ContentOverrides,
  CreatePostTransaction,
  CredentialGuard,
  IdempotentPostRecord,
  NewPostRecord,
  NewPublicationRecord,
} from "../contracts/execution.js";
import type { NewOutboxJobRecord } from "../contracts/outbox.js";
import {
  InvalidContractInputError,
  compareInstants,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { Logger } from "../ports/logger.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import type {
  PreparedPublisher,
  PublisherBlockReason,
  PublisherPreparation,
} from "../ports/publisher-strategy.js";
import type { PublishingStore } from "../ports/publishing-store.js";
import {
  EMPTY_DISPATCH_REPORT,
  dispatchReadyJobs,
  dispatchReportDeferred,
  type DispatchReport,
} from "./dispatch-ready-jobs.js";
import {
  PublishingUseCaseError,
  createUseCaseId,
  readClockNow,
  snapshotCreateInput,
  snapshotIdempotencyKey,
  type PublishingErrorCode,
  type PublishingErrorReason,
  type UseCaseClock,
  type UseCaseIdFactory,
} from "./shared.js";

/**
 * Already-composed per-platform preparation. It performs no network work and
 * returns either an immutable Publisher envelope or a safe blocked reason.
 */
export type PreparePublisher = (
  platform: Platform,
  now: IsoInstant,
) => Promise<PublisherPreparation>;

export interface CreatePostDependencies {
  readonly publishing: PublishingStore;
  readonly outbox: OutboxStore;
  readonly queue: JobQueue;
  readonly signer: BindingSigner;
  readonly prepare: PreparePublisher;
  readonly clock: UseCaseClock;
  readonly ids: UseCaseIdFactory;
  /** Best-effort structured sink; forwarded to the fast-path dispatch. */
  readonly logger?: Logger;
  /** Optional deadline/budget predicate for the fast-path dispatch. */
  readonly shouldContinueDispatch?: () => boolean;
  /** Optional lower fast-path budget; the dispatcher caps it at 20. */
  readonly dispatchLimit?: number;
}

/** Compact acceptance result for the HTTP layer. */
export interface CreatePostResult {
  readonly postId: string;
  /** Current Post status: `queued`/`scheduled` on create, current on replay. */
  readonly status: PostStatus;
  readonly scheduledAt: IsoInstant | null;
  readonly replayed: boolean;
  /** True when the fast path left due work for the next wake. */
  readonly enqueueDeferred: boolean;
  readonly dispatch: DispatchReport;
}

interface PlannedPublication {
  readonly platform: Platform;
  readonly publicationId: string;
  readonly jobId: string;
}

interface PreparedEntry extends PlannedPublication {
  readonly prepared: PreparedPublisher;
  readonly credentialBinding: string;
}

export async function createPost(
  input: CreatePostInput,
  dependencies: CreatePostDependencies,
  idempotencyKey?: string | null,
): Promise<CreatePostResult> {
  // Snapshot before any await: the fingerprint and the committed content must
  // come from this copy, never from a caller that mutates its own object while
  // the use case is suspended.
  const request = snapshotCreateInput(input);
  const key = snapshotIdempotencyKey(idempotencyKey);

  // Derived only from the snapshot above.
  const fingerprint = await canonicalCreateRequestFingerprint({
    content: request.content,
    platforms: request.platforms,
    overrides: request.overrides,
    scheduledAt: request.scheduledAt,
  });

  if (key !== null) {
    // Idempotent replay is answered before preparation, signing or any
    // readiness/configuration check: an accepted request keeps replaying even
    // after its credential was removed.
    const existing = await dependencies.publishing.findIdempotentPost({
      scope: CREATE_POST_SCOPE,
      key,
    });
    if (existing !== null) {
      return replayExisting(existing, fingerprint);
    }
  }

  // Only a request that may actually commit needs a dispatch budget, and only
  // a request that commits needs the queue: a replay stays independent of the
  // clock, the dispatcher, the queue and every configuration concern.
  assertDispatchLimit(dependencies.dispatchLimit);
  const now = readClockNow(dependencies.clock);

  const scheduled =
    request.scheduledAt !== null && compareInstants(request.scheduledAt, now) > 0;

  // Identity is generated once per accepted request; a concurrent store replay
  // discards these values and returns the record the store committed.
  const postId = createUseCaseId(dependencies.ids, "post");
  const planned: readonly PlannedPublication[] = request.platforms.map((platform) => ({
    platform,
    publicationId: createUseCaseId(dependencies.ids, "publication"),
    jobId: createUseCaseId(dependencies.ids, "job"),
  }));

  const prepared: PreparedEntry[] = [];
  for (const entry of planned) {
    const publisher = await prepareOrFail(dependencies.prepare, entry.platform, now);
    if (publisher.platform !== entry.platform) {
      throw new InvalidContractInputError("strategy returned a different platform");
    }
    const credentialBinding = await signBindingOrFail(publisher, dependencies.signer);
    prepared.push({ ...entry, prepared: publisher, credentialBinding });
  }

  const transaction = buildTransaction({
    key,
    fingerprint,
    now,
    request,
    postId,
    scheduled,
    prepared,
  });

  const commit = await dependencies.publishing.createPostWithDispatch(transaction);
  switch (commit.kind) {
    case "created": {
      const accepted = {
        postId,
        status: transaction.post.status,
        scheduledAt: request.scheduledAt,
        replayed: false,
      } as const;
      if (scheduled) {
        // Future intent needs no immediate send, and the fast path must not
        // spend its budget scanning unrelated due work on this request.
        return acceptedResult(accepted, EMPTY_DISPATCH_REPORT, false);
      }
      const jobIds = transaction.jobs.map((job) => job.id);
      const report = await runFastPathDispatch(dependencies, now, postId);
      if (report === null) {
        // The create is committed; the pending outbox rows recover later.
        return acceptedResult(accepted, EMPTY_DISPATCH_REPORT, true);
      }
      // An older backlog may have consumed the whole budget, so confirm the
      // jobs this create owns instead of trusting the global counters.
      const confirmed = new Set(report.confirmedJobIds);
      const unconfirmed = jobIds.some((jobId) => !confirmed.has(jobId));
      return acceptedResult(accepted, report, dispatchReportDeferred(report) || unconfirmed);
    }
    case "replayed":
      // A concurrent request with the same key committed first; the canonical
      // comparison rule is identical to the early replay path, and the stored
      // receipt is returned without touching the queue.
      return replayExisting(commit.record, fingerprint);
    case "conflict":
      // Zero rows changed. A slot guard conflict is a safe conflict: never
      // silently re-prepare or retry the write.
      throw new PublishingUseCaseError("CREATE_CONFLICT", commit.reason);
  }
}

function buildTransaction(input: {
  readonly key: string | null;
  readonly fingerprint: string;
  readonly now: IsoInstant;
  readonly request: ReturnType<typeof snapshotCreateInput>;
  readonly postId: string;
  readonly scheduled: boolean;
  readonly prepared: readonly PreparedEntry[];
}): CreatePostTransaction {
  const { request, now, scheduled } = input;
  const overrides: ContentOverrides = request.overrides;
  const post: NewPostRecord = Object.freeze({
    id: input.postId,
    content: request.content,
    platforms: request.platforms,
    overrides,
    scheduledAt: request.scheduledAt,
    status: scheduled ? "scheduled" : "queued",
    createdAt: now,
  });
  const publications: readonly NewPublicationRecord[] = input.prepared.map((entry) =>
    Object.freeze({
      id: entry.publicationId,
      postId: input.postId,
      platform: entry.platform,
      provider: entry.prepared.publisher.name,
      content: overrides[entry.platform]?.content ?? request.content,
      status: scheduled ? "scheduled" : "pending",
      scheduledAt: request.scheduledAt,
      credentialBinding: entry.credentialBinding,
      credentialRevision: entry.prepared.credentialRevision,
      createdAt: now,
    }),
  );
  const jobs: readonly NewOutboxJobRecord[] = input.prepared.map((entry) =>
    Object.freeze({
      id: entry.jobId,
      kind: "delivery.execute",
      aggregateId: entry.publicationId,
      attemptNo: 1,
      // Future intent keeps the original wall-clock time; immediate work is due
      // now. The outbox, not the Post, carries execution scheduling.
      availableAt: scheduled && request.scheduledAt !== null ? request.scheduledAt : now,
    }),
  );
  const credentialGuards: readonly CredentialGuard[] = input.prepared.map((entry) =>
    Object.freeze({
      platform: entry.platform,
      expectedRevision: entry.prepared.credentialRevision,
      bindingId: entry.prepared.slotBindingId,
    }),
  );
  return Object.freeze({
    scope: CREATE_POST_SCOPE,
    idempotencyKey: input.key,
    requestFingerprint: input.fingerprint,
    now,
    post,
    publications: Object.freeze([...publications]),
    jobs: Object.freeze([...jobs]),
    credentialGuards: Object.freeze([...credentialGuards]),
  });
}

/**
 * Replay path: the stored record *is* the answer. It is returned with an empty
 * dispatch report, so a replay never depends on the queue, the dispatcher, the
 * clock or any configuration/readiness check.
 */
function replayExisting(
  record: IdempotentPostRecord,
  fingerprint: string,
): CreatePostResult {
  if (record.requestFingerprint !== fingerprint) {
    throw new PublishingUseCaseError("IDEMPOTENCY_CONFLICT");
  }
  return acceptedResult(
    {
      postId: record.post.id,
      status: record.post.status,
      scheduledAt: record.post.scheduledAt,
      replayed: true,
    },
    EMPTY_DISPATCH_REPORT,
    false,
  );
}

function acceptedResult(
  accepted: {
    readonly postId: string;
    readonly status: PostStatus;
    readonly scheduledAt: IsoInstant | null;
    readonly replayed: boolean;
  },
  report: DispatchReport,
  enqueueDeferred: boolean,
): CreatePostResult {
  return Object.freeze({
    postId: accepted.postId,
    status: accepted.status,
    scheduledAt: accepted.scheduledAt,
    replayed: accepted.replayed,
    enqueueDeferred,
    dispatch: report,
  });
}

/**
 * The fast path is an optimization. Its failure must not roll back the
 * committed create or change the accepted result; the pending outbox rows are
 * recovered by the next routine wake.
 */
async function runFastPathDispatch(
  dependencies: CreatePostDependencies,
  now: IsoInstant,
  postId: string,
): Promise<DispatchReport | null> {
  try {
    return await dispatchReadyJobs({
      outbox: dependencies.outbox,
      queue: dependencies.queue,
      now,
      ...(dependencies.dispatchLimit === undefined
        ? {}
        : { limit: dependencies.dispatchLimit }),
      ...(dependencies.shouldContinueDispatch === undefined
        ? {}
        : { shouldContinue: dependencies.shouldContinueDispatch }),
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    });
  } catch {
    writeCreateLog(dependencies.logger, {
      level: "warn",
      event: "post_dispatch_deferred",
      fields: { postId, code: "STORE_UNAVAILABLE" },
    });
    return null;
  }
}

async function prepareOrFail(
  prepare: PreparePublisher,
  platform: Platform,
  now: IsoInstant,
): Promise<PreparedPublisher> {
  let preparation: PublisherPreparation;
  try {
    preparation = await prepare(platform, now);
  } catch (error) {
    // Never rethrow an injected object: a strategy or signer can construct one
    // of our exported error classes (or a subclass) whose message or cause
    // carries configuration material. Map it to a freshly built fixed error.
    throw prepareFailure(error);
  }
  if (preparation.kind === "blocked") {
    // Fixed code plus an allowlisted reason; the blocked status, missing field
    // names and any provider text stay out of the error.
    throw new PublishingUseCaseError(
      "PUBLISHER_PREPARATION_BLOCKED",
      safeBlockReason(preparation.reason),
    );
  }
  return preparation.prepared;
}

async function signBindingOrFail(
  publisher: PreparedPublisher,
  signer: BindingSigner,
): Promise<string> {
  try {
    return await computeCredentialBinding(publisher.bindingMaterial, signer);
  } catch (error) {
    // A failing signer means the instance's binding key is unusable: that is an
    // instance-wide 503 condition, never a platform-specific readiness result.
    // The thrown object is untrusted, so only a reconstructed fixed error
    // leaves this function.
    throw new PublishingUseCaseError(
      "INSTANCE_NOT_READY",
      isDocumentedContractViolation(error) ? "invalid_configuration" : "unavailable",
    );
  }
}

/**
 * Rebuild a fixed, cause-free error for any injected failure.
 *
 * A later composition may classify a preparation failure itself by throwing a
 * `PublishingUseCaseError`; only its fixed allowlisted code and reason survive,
 * reconstructed here with our own message. Everything else — including a
 * forged subclass, its message, its `cause` and any custom fields — becomes a
 * platform readiness error, except the documented contract-violation shape,
 * which becomes a safe `invalid_configuration` reason.
 */
function prepareFailure(error: unknown): PublishingUseCaseError {
  const classified = preserveClassifiedFailure(error);
  if (classified !== null) {
    return classified;
  }
  return new PublishingUseCaseError(
    "PUBLISHER_PREPARATION_BLOCKED",
    isDocumentedContractViolation(error) ? "invalid_configuration" : "unavailable",
  );
}

/** Codes a preparation step may legitimately classify for the runtime. */
const PRESERVED_PREPARE_CODES: readonly PublishingErrorCode[] = Object.freeze([
  "INSTANCE_NOT_READY",
  "PUBLISHER_PREPARATION_BLOCKED",
]);

function preserveClassifiedFailure(error: unknown): PublishingUseCaseError | null {
  if (!(error instanceof PublishingUseCaseError)) {
    return null;
  }
  const code = error.code;
  if (!PRESERVED_PREPARE_CODES.includes(code)) {
    return null;
  }
  // Rebuild with our own message; only the allowlisted reason is carried over.
  return new PublishingUseCaseError(code, safeErrorReason(error.reason));
}

const PUBLISHING_ERROR_REASONS: readonly string[] = Object.freeze([
  "request_body",
  "content",
  "platforms",
  "overrides",
  "scheduled_at",
  "idempotency_key",
  "missing_credentials",
  "needs_configuration",
  "expired",
  "reconnect_required",
  "unavailable",
  "invalid_configuration",
  "credential_revision_mismatch",
  "duplicate_publication",
  "duplicate_job",
  "duplicate_attempt",
  "invalid_input",
]);

function safeErrorReason(value: unknown): PublishingErrorReason | null {
  return typeof value === "string" && PUBLISHING_ERROR_REASONS.includes(value)
    ? (value as PublishingErrorReason)
    : null;
}

function isDocumentedContractViolation(error: unknown): boolean {
  return error instanceof InvalidContractInputError && error.name === "InvalidContractInputError";
}

const PUBLISHER_BLOCK_REASONS: readonly PublisherBlockReason[] = Object.freeze([
  "missing_credentials",
  "needs_configuration",
  "expired",
  "reconnect_required",
  "unavailable",
  "invalid_configuration",
]);

/** Allowlist the block reason: an injected envelope cannot smuggle free text. */
function safeBlockReason(value: unknown): PublisherBlockReason {
  const reason = safeErrorReason(value);
  return reason !== null && PUBLISHER_BLOCK_REASONS.includes(reason as PublisherBlockReason)
    ? (reason as PublisherBlockReason)
    : "unavailable";
}

function assertDispatchLimit(limit: number | undefined): void {
  if (limit === undefined) {
    return;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new InvalidContractInputError("dispatch limit must be a positive safe integer");
  }
}

function writeCreateLog(logger: Logger | undefined, event: Parameters<Logger["write"]>[0]): void {
  if (logger === undefined) {
    return;
  }
  try {
    logger.write(event);
  } catch {
    // Swallow: observability must not break the accepted create.
  }
}
