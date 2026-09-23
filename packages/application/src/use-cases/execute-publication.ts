/**
 * Portable publication consumer.
 *
 * One decoded queue message is one attempt opportunity for one outbox job. The
 * order below is the safety contract:
 *
 * 1. Strictly decode the versioned envelope; a malformed message never touches
 *    the store or a provider.
 * 2. Load the exact job/entity pair and refuse absent, old, terminal, claimed,
 *    unsupported, cancelled, DLQ-seen or not-due work without a provider call.
 * 3. Prepare the frozen publisher and verify the connection binding and the
 *    credential revision before claiming.
 * 4. Claim atomically, then invoke the provider exactly once, inside its own
 *    catch.
 * 5. Commit one pre-built outcome, including the pre-generated retry job and
 *    the planned archive key, retrying only the identical local write object.
 * 6. Write the archive strictly afterwards, best effort, outside the provider
 *    catch and outside every outcome decision.
 *
 * No D1, Queue, R2 or provider-package API appears here.
 */

import type {
  PublicationStatus,
  PublishErrorCode,
  PublishRequest,
  PublishResult,
  Publisher,
} from "@syndroo/core";

import {
  computeCredentialBinding,
  credentialBindingMatches,
  type BindingSigner,
} from "../contracts/binding.js";
import type {
  ClaimBlockReason,
  ClaimResult,
  ExecutionCommit,
  ExecutionSnapshot,
  PlannedArchive,
  PublicationSnapshot,
  TerminalReason,
} from "../contracts/execution.js";
import { decodeQueueEnvelopeV1, type OutboxJob } from "../contracts/outbox.js";
import {
  PUBLISHER_MAX_ATTEMPTS,
  isDueAt,
  type CommitConflictReason,
  type ConsumerOutcome,
  type ConsumerRetryReason,
  type ConsumerSettledReason,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { SafeLogEvent, ArchiveOutcome, ArchiveCode } from "../contracts/storage.js";
import type { ArchiveStore } from "../ports/archive-store.js";
import type { Logger } from "../ports/logger.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import type { PreparedPublisher, PublisherPreparation } from "../ports/publisher-strategy.js";
import type { PublishingStore } from "../ports/publishing-store.js";
import type { PreparePublisher } from "./create-post.js";
import { writeArchiveBestEffort } from "./execution-archive.js";
import {
  archiveMetadataForFailure,
  archiveMetadataForPublished,
  decideFailureOutcome,
  infrastructureRetry,
  nextExecutionId,
  normalizePublishFailure,
  planArchive,
  safeProviderIdentifier,
  settled,
  type ArchivePlan,
  type ExecutionIdFactory,
  type FailureDecision,
  type PublishFailureView,
} from "./execution-policy.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

const TERMINAL_PUBLICATION_STATUSES: readonly PublicationStatus[] = ["published", "failed"];

/** Local write attempts for one identical outcome object. */
const COMMIT_WRITE_ATTEMPTS = 3;

export interface ExecutePublicationDependencies {
  readonly publishing: PublishingStore;
  readonly outbox: OutboxStore;
  /** Already-composed preparation; the same function the create path uses. */
  readonly prepare: PreparePublisher;
  readonly signer: BindingSigner;
  readonly clock: UseCaseClock;
  readonly ids: ExecutionIdFactory;
  /** Optional diagnostic archive; absent means "plan nothing", never a fake. */
  readonly archive?: ArchiveStore;
  readonly logger?: Logger;
  /** Test-only lowering of the archive budget; the helper caps it at 2s. */
  readonly archiveBudgetMs?: number;
}

interface ConsumerContext {
  readonly dependencies: ExecutePublicationDependencies;
  /**
   * Observation time used for the read-only eligibility decision (due/future).
   * Writes never reuse it: claim, rejection, DLQ settlement and the frozen
   * outcome each read the clock at the moment they act.
   */
  readonly eligibilityNow: IsoInstant;
  readonly publication: PublicationSnapshot;
  readonly job: OutboxJob;
}

export async function executePublication(
  message: unknown,
  dependencies: ExecutePublicationDependencies,
): Promise<ConsumerOutcome> {
  const decoded = decodeQueueEnvelopeV1(message);
  if (decoded.kind === "invalid") {
    // A rejected envelope may carry credential or body material, so only the
    // fixed reason is logged and nothing is loaded or called.
    writeLog(dependencies.logger, {
      level: "warn",
      event: "execution_skipped",
      fields: { code: "malformed_envelope" },
    });
    return infrastructureRetry("malformed_envelope");
  }
  const envelope = decoded.envelope;
  const eligibilityNow = readClockNow(dependencies.clock);

  let execution: ExecutionSnapshot | null;
  try {
    execution = await dependencies.publishing.getExecution({
      jobId: envelope.jobId,
      publicationId: envelope.entityId,
    });
  } catch {
    return infrastructureRetry("store_unavailable");
  }
  if (execution === null) {
    writeLog(dependencies.logger, {
      level: "info",
      event: "execution_skipped",
      fields: { code: "stale_job", jobId: envelope.jobId },
    });
    return settled("stale_job");
  }

  const context: ConsumerContext = {
    dependencies,
    eligibilityNow,
    publication: execution.publication,
    job: execution.job,
  };
  const { publication, job } = context;

  // ---- eligibility: no provider call may happen below this line ----------
  if (
    job.kind !== "delivery.execute" ||
    job.aggregateId !== publication.id ||
    publication.currentJobId !== job.id
  ) {
    // An unsupported persisted protocol, a superseded job, a mismatched entity
    // is never guessed into the current protocol.
    return skip(context, "stale_job");
  }
  if (TERMINAL_PUBLICATION_STATUSES.includes(publication.status)) {
    return skip(context, "terminal");
  }
  if (job.status === "cancelled") {
    // The transport intent is finished; no provider call is needed or allowed.
    return skip(context, "stale_job");
  }
  if (publication.claimToken !== null) {
    // A live claim already owns this attempt; a duplicate settles normally and
    // schedules no placeholder retry.
    return skip(context, "duplicate");
  }
  if (job.dlqSeenAt !== null) {
    // Transport intent already failed: settle through the DLQ path only.
    return await settleDeadLetter(context);
  }
  if (!isDueAt(job.availableAt, eligibilityNow)) {
    return await rearmEarlyMessage(context);
  }
  if (publication.credentialBinding === null) {
    // A stored publication without a binding is a legacy/unbound record. It can
    // be rejected before preparation, so a missing or unusable key can never
    // misclassify it as a configuration error or defer it forever.
    return await rejectTerminal(context, "legacy_unbound", "AUTH");
  }
  if (publication.attempts >= PUBLISHER_MAX_ATTEMPTS) {
    // The attempt budget is spent: the work can never execute, so the record is
    // closed without a provider call instead of being left pending forever.
    return await rejectTerminal(context, "attempts_exhausted", null);
  }
  if (job.attemptNo !== publication.attempts + 1) {
    // A stale attempt number belongs to an older execution opportunity and is
    // never reinterpreted as the current one.
    return skip(context, "stale_job");
  }

  // ---- preparation: still no claim, still no provider ---------------------
  const preparation = await prepareForExecution(context);
  if (preparation.kind === "stop") {
    return preparation.outcome;
  }
  const publisher = preparation.publisher;

  // The claim is a new mutation: it observes the clock now, not at queue start,
  // and it never re-reads a credential after this point.
  const claimNow = readClockNow(dependencies.clock);
  const claimToken = nextExecutionId(dependencies.ids, "claim");
  const attemptId = nextExecutionId(dependencies.ids, "attempt");
  let claim: ClaimResult;
  try {
    claim = await dependencies.publishing.claimExecution({
      jobId: job.id,
      publicationId: publication.id,
      attemptNo: job.attemptNo,
      now: claimNow,
      credentialSlotRevision: publisher.credentialRevision,
      claimToken,
      attemptId,
    });
  } catch {
    return retry(context, "store_unavailable");
  }
  if (claim.kind === "unknown") {
    // The claim may have committed; the provider is never invoked on a guess.
    return retry(context, "store_unavailable");
  }
  if (claim.kind === "not_claimed") {
    return await settleClaimBlock(context, claim.reason);
  }

  // ---- provider invocation: exactly once, in its own catch ----------------
  const providerOutcome = await runPublisher(publisher.publisher, {
    publicationId: publication.id,
    platform: publication.platform,
    content: publication.content,
  });

  // ---- outcome: every identity is generated before persistence ------------
  // One fresh completion timestamp is frozen for the commit, the retry baseline
  // and the archive plan, so a slow provider can never shorten the 60s/120s
  // business delay or backdate the persisted result.
  const outcomeNow = readClockNow(dependencies.clock);
  const attempts = claim.execution.publication.attempts;
  const built = buildCommit(context, {
    attemptId,
    claimToken,
    attempts,
    providerOutcome,
    now: outcomeNow,
  });

  const commit = await commitWithRetry(dependencies.publishing, built.commit);
  if (commit.kind === "unavailable") {
    // The publisher already ran; the live claim keeps the fence and the
    // watchdog path owns the eventual conservative result.
    return retry(context, "store_unavailable");
  }
  if (commit.kind === "conflict") {
    // A conflict can never authorize a second provider call: re-read to explain
    // it, and settle without publishing again.
    return await settleUnresolvedCommit(context, commit.reason);
  }

  writeLog(dependencies.logger, {
    level: "info",
    event: "execution_outcome",
    fields: { code: built.outcomeCode, attempt: attempts, jobId: job.id },
  });
  const archivePlan = built.archivePlan;
  if (archivePlan !== null && dependencies.archive !== undefined) {
    await writeArchiveBestEffort({
      archive: dependencies.archive,
      publishing: dependencies.publishing,
      publicationId: publication.id,
      jobId: job.id,
      attemptId,
      plan: archivePlan,
      now: outcomeNow,
      ...(dependencies.archiveBudgetMs === undefined
        ? {}
        : { budgetMs: dependencies.archiveBudgetMs }),
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    });
  }
  return settled("executed");
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

type PreparationStep =
  | { readonly kind: "ready"; readonly publisher: PreparedPublisher }
  | { readonly kind: "stop"; readonly outcome: ConsumerOutcome };

/**
 * Prepare the frozen publisher and verify connection identity before any claim.
 *
 * Temporary preparation failures keep the attempt budget intact and defer the
 * message; permanent ones close the publication without ever calling a
 * provider.
 */
async function prepareForExecution(context: ConsumerContext): Promise<PreparationStep> {
  const { dependencies, eligibilityNow, publication } = context;
  let preparation: PublisherPreparation;
  try {
    preparation = await dependencies.prepare(publication.platform, eligibilityNow);
  } catch {
    // Read, decrypt or strategy failure: temporary by default.
    return { kind: "stop", outcome: retry(context, "preparation_deferred") };
  }
  if (preparation.kind === "blocked") {
    if (preparation.reason === "unavailable") {
      return { kind: "stop", outcome: retry(context, "preparation_deferred") };
    }
    // Missing, expired, reconnect-required or invalid configuration is a
    // permanent pre-provider condition for this publication, recorded as an
    // unambiguous authorization failure.
    return {
      kind: "stop",
      outcome: await rejectTerminal(context, "invalid_configuration", "AUTH"),
    };
  }
  const prepared = preparation.prepared;
  if (prepared.platform !== publication.platform) {
    // Composition defect: never invoke a provider for a different platform.
    return { kind: "stop", outcome: retry(context, "preparation_deferred") };
  }

  let binding: string;
  try {
    binding = await computeCredentialBinding(prepared.bindingMaterial, dependencies.signer);
  } catch {
    // A signer/key failure is an instance condition, never a platform result.
    return { kind: "stop", outcome: retry(context, "preparation_deferred") };
  }
  if (!credentialBindingMatches(publication.credentialBinding, binding)) {
    // The connection this record was created against no longer exists.
    return {
      kind: "stop",
      outcome: await rejectTerminal(context, "binding_mismatch", "AUTH"),
    };
  }
  return { kind: "ready", publisher: prepared };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderOutcome =
  | {
      readonly kind: "published";
      readonly externalId: string | null;
      readonly externalUrl: string | null;
    }
  | { readonly kind: "failed"; readonly failure: PublishFailureView };

/**
 * The only place a provider is invoked.
 *
 * The catch covers the provider call alone: outcome persistence and archive
 * work stay outside it, and an unrecognised throw is reduced to an allowlisted
 * ambiguous failure without copying its message or cause.
 */
async function runPublisher(
  publisher: Publisher,
  request: PublishRequest,
): Promise<ProviderOutcome> {
  let result: PublishResult;
  try {
    result = await publisher.publish(request);
  } catch (error) {
    return Object.freeze({
      kind: "failed" as const,
      failure: normalizePublishFailure(error),
    });
  }
  // Bounded, guarded metadata snapshot: a hostile or malformed result must not
  // turn a successful publish into an escaping error, and the raw result is
  // never logged or archived.
  let externalId: string | null = null;
  let externalUrl: string | null = null;
  try {
    const record = (result ?? {}) as PublishResult;
    externalId = safeProviderIdentifier(record.externalId);
    externalUrl = safeProviderIdentifier(record.externalUrl);
  } catch {
    // Metadata is omitted; the publish itself still succeeded.
  }
  return Object.freeze({
    kind: "published" as const,
    externalId,
    externalUrl,
  });
}

function failureDecisionOf(
  context: ConsumerContext,
  failure: PublishFailureView,
  attempts: number,
  now: IsoInstant,
): FailureDecision {
  return decideFailureOutcome({ failure, attempts, now });
}

// ---------------------------------------------------------------------------
// Outcome commit
// ---------------------------------------------------------------------------

function buildCommit(
  context: ConsumerContext,
  input: {
    readonly attemptId: string;
    readonly claimToken: string;
    readonly attempts: number;
    readonly providerOutcome: ProviderOutcome;
    readonly now: IsoInstant;
  },
): {
  readonly commit: ExecutionCommit;
  readonly outcomeCode: string;
  readonly archivePlan: ArchivePlan | null;
} {
  const { publication, job } = context;
  const now = input.now;
  const base = {
    jobId: job.id,
    publicationId: publication.id,
    attemptId: input.attemptId,
    claimToken: input.claimToken,
    now,
  } as const;

  if (input.providerOutcome.kind === "published") {
    const plan = archivePlanFor(context, input.attemptId, now, archiveMetadataForPublished());
    return {
      commit: Object.freeze({
        ...base,
        outcome: "published" as const,
        externalId: input.providerOutcome.externalId,
        externalUrl: input.providerOutcome.externalUrl,
        archive: plannedArchive(plan),
      }),
      outcomeCode: "published",
      archivePlan: plan,
    };
  }

  const failure = input.providerOutcome.failure;
  const decision = failureDecisionOf(context, failure, input.attempts, now);
  const plan = archivePlanFor(
    context,
    input.attemptId,
    now,
    archiveMetadataForFailure(failure, decision),
  );
  if (decision.kind === "retry") {
    return {
      commit: Object.freeze({
        ...base,
        outcome: "safe_retry" as const,
        errorCode: failure.code,
        retryAt: decision.retryAt,
        nextJob: Object.freeze({
          id: nextExecutionId(context.dependencies.ids, "job"),
          kind: "delivery.execute" as const,
          aggregateId: publication.id,
          attemptNo: decision.nextAttemptNo,
          availableAt: decision.retryAt,
        }),
        archive: plannedArchive(plan),
      }),
      outcomeCode: "retry_scheduled",
      archivePlan: plan,
    };
  }
  return {
    commit: Object.freeze({
      ...base,
      outcome: "failed" as const,
      terminalReason: decision.terminalReason,
      errorCode: decision.errorCode,
      errorAmbiguous: decision.errorAmbiguous,
      archive: plannedArchive(plan),
    }),
    outcomeCode: "failed",
    archivePlan: plan,
  };
}

function plannedArchive(plan: ArchivePlan | null): PlannedArchive | null {
  return plan === null ? null : Object.freeze({ key: plan.key });
}

type CommitAttempt =
  | { readonly kind: "written" }
  | { readonly kind: "conflict"; readonly reason: CommitConflictReason }
  | { readonly kind: "unavailable" };

/**
 * Persist one identical outcome object, retrying only transient throws.
 *
 * The same object reference is reused, so a committed write whose
 * acknowledgement was lost is replayed as the same logical commit and never as
 * a second publishing decision. A conflict is returned immediately, because it
 * must never become another provider call.
 */
async function commitWithRetry(
  publishing: PublishingStore,
  commit: ExecutionCommit,
): Promise<CommitAttempt> {
  for (let attempt = 1; attempt <= COMMIT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const result = await publishing.commitExecution(commit);
      if (result.kind === "applied" || result.kind === "already_applied") {
        return Object.freeze({ kind: "written" as const });
      }
      return Object.freeze({ kind: "conflict" as const, reason: result.reason });
    } catch {
      // Transient local failure: retry the exact same write, never the provider.
    }
  }
  return Object.freeze({ kind: "unavailable" as const });
}

/**
 * Explain a conflicted outcome without publishing again.
 *
 * A conflict means the claim or the outcome fingerprint no longer matches this
 * attempt, so the provider result is discarded rather than re-derived.
 */
async function settleUnresolvedCommit(
  context: ConsumerContext,
  reason: CommitConflictReason,
): Promise<ConsumerOutcome> {
  const { dependencies, publication, job } = context;
  writeLog(dependencies.logger, {
    level: "warn",
    event: "execution_commit_conflict",
    fields: { code: reason, jobId: job.id },
  });
  let reread: ExecutionSnapshot | null;
  try {
    reread = await dependencies.publishing.getExecution({
      jobId: job.id,
      publicationId: publication.id,
    });
  } catch {
    // No second provider call; the live claim keeps the fence for the next wake.
    return retry(context, "store_unavailable");
  }
  if (reread === null) {
    return skip(context, "stale_job");
  }
  if (TERMINAL_PUBLICATION_STATUSES.includes(reread.publication.status)) {
    return skip(context, "terminal");
  }
  if (reread.publication.currentJobId !== job.id) {
    return skip(context, "stale_job");
  }
  return skip(context, "duplicate");
}

// ---------------------------------------------------------------------------
// Terminal and deferred settlements
// ---------------------------------------------------------------------------

async function settleClaimBlock(
  context: ConsumerContext,
  reason: ClaimBlockReason,
): Promise<ConsumerOutcome> {
  switch (reason) {
    case "already_claimed":
      return skip(context, "duplicate");
    case "terminal":
      return skip(context, "terminal");
    case "credential_revision_mismatch":
      // The slot changed after preparation; re-preparing on this message is not
      // authorized and no provider call may happen.
      return retry(context, "preparation_deferred");
    case "attempt_budget_exhausted":
      return await rejectTerminal(context, "attempts_exhausted", null);
    case "dlq_seen":
      return await settleDeadLetter(context);
    case "not_due":
      return await rearmEarlyMessage(context);
    default:
      return skip(context, "stale_job");
  }
}

async function rejectTerminal(
  context: ConsumerContext,
  terminalReason: TerminalReason,
  errorCode: PublishErrorCode | null,
): Promise<ConsumerOutcome> {
  const { dependencies, publication, job } = context;
  try {
    const result = await dependencies.publishing.rejectBeforeExecution({
      jobId: job.id,
      publicationId: publication.id,
      // A mutation observes the clock when it acts, not at queue start.
      now: readClockNow(dependencies.clock),
      terminalReason,
      errorCode,
    });
    if (result.kind === "conflict" && result.reason === "already_claimed") {
      return skip(context, "duplicate");
    }
    return skip(context, "pre_execution_rejected");
  } catch {
    return retry(context, "store_unavailable");
  }
}

async function settleDeadLetter(context: ConsumerContext): Promise<ConsumerOutcome> {
  const { dependencies, publication, job } = context;
  try {
    const outcome = await dependencies.publishing.settleDeadLetter({
      jobId: job.id,
      publicationId: publication.id,
      now: readClockNow(dependencies.clock),
      transportReason: job.transportReason ?? "queue_dlq",
    });
    switch (outcome.kind) {
      case "dead_lettered":
        return skip(context, "dead_lettered");
      case "recovered_unknown":
        return skip(context, "terminal");
      case "not_found":
        return skip(context, "stale_job");
      case "recorded":
        switch (outcome.reason) {
          case "terminal":
            return skip(context, "terminal");
          case "active_claim":
            return skip(context, "duplicate");
          case "not_due":
            return skip(context, "not_due");
          default:
            return skip(context, "stale_job");
        }
    }
  } catch {
    return retry(context, "dlq_metadata_write_failed");
  }
}

/**
 * Restore durable dispatch intent for a future current job.
 *
 * Only a confirmed re-arm lets this message be acknowledged: the same job id
 * keeps its original `availableAt`, and a failed or conflicting write becomes
 * an infrastructure retry so the scheduler can still reach the future intent.
 */
async function rearmEarlyMessage(context: ConsumerContext): Promise<ConsumerOutcome> {
  const { dependencies, publication, job } = context;
  try {
    const rearm = await dependencies.outbox.rearmCurrentJob({
      jobId: job.id,
      publicationId: publication.id,
      now: readClockNow(dependencies.clock),
      reason: "early_message",
    });
    return rearm.kind === "rearmed"
      ? skip(context, "not_due")
      : retry(context, "rearm_write_failed");
  } catch {
    return retry(context, "rearm_write_failed");
  }
}

// ---------------------------------------------------------------------------
// Archive planning and logging
// ---------------------------------------------------------------------------

function archivePlanFor(
  context: ConsumerContext,
  attemptId: string,
  now: IsoInstant,
  metadata: { readonly outcome: ArchiveOutcome; readonly code: ArchiveCode | null },
): ArchivePlan | null {
  if (context.dependencies.archive === undefined) {
    // No archive binding: plan nothing rather than pretend a record exists.
    return null;
  }
  return planArchive({
    now,
    publicationId: context.publication.id,
    jobId: context.job.id,
    attemptId,
    platform: context.publication.platform,
    outcome: metadata.outcome,
    code: metadata.code,
    // No typed HTTP evidence is threaded through the portable provider result,
    // so the diagnostic carries null instead of a guessed status.
    httpStatus: null,
  });
}

function skip(context: ConsumerContext, reason: ConsumerSettledReason): ConsumerOutcome {
  writeLog(context.dependencies.logger, {
    level: "info",
    event: "execution_skipped",
    fields: { code: reason, jobId: context.job.id },
  });
  return settled(reason);
}

function retry(context: ConsumerContext, reason: ConsumerRetryReason): ConsumerOutcome {
  writeLog(context.dependencies.logger, {
    level: "warn",
    event: "execution_deferred",
    fields: { code: reason, jobId: context.job.id },
  });
  return infrastructureRetry(reason);
}

function writeLog(logger: Logger | undefined, event: SafeLogEvent): void {
  if (logger === undefined) {
    return;
  }
  try {
    logger.write(event);
  } catch {
    // Swallow: observability must never change a publishing outcome.
  }
}
