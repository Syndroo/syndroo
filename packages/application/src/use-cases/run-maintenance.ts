/**
 * Portable bounded maintenance orchestration.
 *
 * One wake runs four independent transactions in order: stale recovery, expired
 * OAuth cleanup, finished-outbox collection, then the shared dispatcher. Each
 * phase reports its own outcome and each phase reads a fresh canonical instant,
 * because these are separate transactions and no whole-wake atomicity is
 * claimed.
 *
 * A phase that fails reports `failed` with null counts - never a fabricated
 * zero or a successful-looking number - and a fixed store/broker failure does
 * not stop later phases while the caller's budget still permits them. The
 * injected continuation check is consulted before every phase and is handed to
 * the dispatcher, which consults it before every send; a false answer stops
 * starting work but can never cancel a D1 mutation or broker send that was
 * already accepted.
 *
 * This module performs no provider call, no preparation, no decryption, no
 * token refresh and no broker retry of its own: it only composes the existing
 * semantic ports and the accepted dispatcher.
 */

import {
  InvalidContractInputError,
  requireMaintenanceBudget,
  type CleanupResult,
  type IsoInstant,
  type MaintenanceBudget,
  type RecoveryResult,
} from "../contracts/primitives.js";
import type { SafeLogEvent } from "../contracts/storage.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { Logger } from "../ports/logger.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import type { PublishingStore } from "../ports/publishing-store.js";
import { dispatchReadyJobs } from "./dispatch-ready-jobs.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

export type MaintenancePhase =
  | "recovery"
  | "expired_cleanup"
  | "finished_collection"
  | "dispatch";

export type MaintenancePhaseStatus = "completed" | "failed" | "skipped";

/**
 * Fixed outcome code carried in the report itself, so a caller that omits the
 * logger still learns why a phase ended the way it did.
 */
export type MaintenancePhaseCode =
  | "COMPLETED"
  | "STORE_UNAVAILABLE"
  | "MALFORMED_RESULT"
  | "CLOCK_UNAVAILABLE"
  | "BUDGET_EXHAUSTED";

/** Stale-recovery counts, copied verbatim from the completed port call. */
export interface RecoveryPhaseReport {
  readonly phase: "recovery";
  readonly status: MaintenancePhaseStatus;
  readonly code: MaintenancePhaseCode;
  readonly examined: number | null;
  readonly staleClaimsMarkedUnknown: number | null;
  readonly jobsRearmed: number | null;
  readonly jobsDeadLettered: number | null;
  readonly skipped: number | null;
}

/** Rows the expired-secret cleanup actually changed, or null when unknown. */
export interface ExpiredCleanupPhaseReport {
  readonly phase: "expired_cleanup";
  readonly status: MaintenancePhaseStatus;
  readonly code: MaintenancePhaseCode;
  readonly removed: number | null;
}

/** Finished transport intents the collection actually removed, or null. */
export interface FinishedCollectionPhaseReport {
  readonly phase: "finished_collection";
  readonly status: MaintenancePhaseStatus;
  readonly code: MaintenancePhaseCode;
  readonly removed: number | null;
}

/** Dispatch counts. `unstarted` is due work the budget left untouched. */
export interface DispatchPhaseReport {
  readonly phase: "dispatch";
  readonly status: MaintenancePhaseStatus;
  readonly code: MaintenancePhaseCode;
  readonly examined: number | null;
  readonly sent: number | null;
  readonly dispatched: number | null;
  readonly markFailed: number | null;
  readonly sendFailed: number | null;
  readonly sendUnknown: number | null;
  readonly unstarted: number | null;
}

export interface MaintenanceReport {
  readonly recovery: RecoveryPhaseReport;
  readonly expiredCleanup: ExpiredCleanupPhaseReport;
  readonly finishedCollection: FinishedCollectionPhaseReport;
  readonly dispatch: DispatchPhaseReport;
}

/**
 * Explicit per-phase row limits. They come from the caller's measured budget -
 * this module never guesses a production profile - and the dispatcher applies
 * its own twenty-job tick cap on top.
 */
export interface MaintenanceLimits {
  readonly recoveryLimit: number;
  readonly cleanupLimit: number;
  readonly collectionLimit: number;
  /**
   * Explicit dispatch budget for this wake. The caller always states it; the
   * shared dispatcher applies its own twenty-job tick cap on top.
   */
  readonly dispatchLimit: number;
}

export interface RunMaintenanceDependencies {
  readonly publishing: Pick<PublishingStore, "recoverStaleClaims">;
  readonly credentials: Pick<CredentialStore, "cleanupExpired">;
  /** Full outbox port: collection plus the dispatcher's ready/mark calls. */
  readonly outbox: OutboxStore;
  readonly queue: JobQueue;
  readonly clock: UseCaseClock;
  readonly logger?: Logger;
  /** Fixed deadline/budget check; false stops starting new work. */
  readonly shouldContinue?: () => boolean;
}

export async function runMaintenance(
  limits: MaintenanceLimits,
  dependencies: RunMaintenanceDependencies,
): Promise<MaintenanceReport> {
  // Snapshot every validated limit and capture the continuation function
  // before the first await: a caller that mutates its own objects mid-wake, or
  // swaps the predicate, cannot change what this wake was authorized to do.
  const snapshot = snapshotLimits(limits);
  const continuation = latchContinuation(dependencies.shouldContinue);

  const recovery = await runRecoveryPhase(snapshot.recoveryLimit, continuation, dependencies);
  const cleanup = await runCleanupPhase(
    "expired_cleanup",
    snapshot.cleanupLimit,
    (budget) => dependencies.credentials.cleanupExpired(budget),
    continuation,
    dependencies,
  );
  const expiredCleanup: ExpiredCleanupPhaseReport = Object.freeze({
    phase: "expired_cleanup" as const,
    ...cleanup,
  });
  const collection = await runCleanupPhase(
    "finished_collection",
    snapshot.collectionLimit,
    (budget) => dependencies.outbox.collectFinished(budget),
    continuation,
    dependencies,
  );
  const finishedCollection: FinishedCollectionPhaseReport = Object.freeze({
    phase: "finished_collection" as const,
    ...collection,
  });
  const dispatch = await runDispatchPhase(snapshot.dispatchLimit, continuation, dependencies);

  return Object.freeze({ recovery, expiredCleanup, finishedCollection, dispatch });
}

interface LimitSnapshot {
  readonly recoveryLimit: number;
  readonly cleanupLimit: number;
  readonly collectionLimit: number;
  readonly dispatchLimit: number;
}

/**
 * Validate and copy the caller's limits with fixed, cause-free text: a null
 * object, a throwing getter or a proxy trap becomes the same contract error as
 * a bad number, so nothing from a hostile caller object can escape.
 */
function snapshotLimits(limits: MaintenanceLimits): LimitSnapshot {
  return Object.freeze({
    recoveryLimit: readLimit(limits, "recoveryLimit"),
    cleanupLimit: readLimit(limits, "cleanupLimit"),
    collectionLimit: readLimit(limits, "collectionLimit"),
    dispatchLimit: readLimit(limits, "dispatchLimit"),
  });
}

function readLimit(limits: unknown, label: string): number {
  let value: unknown;
  try {
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
      throw new InvalidContractInputError(`${label} must be a positive safe integer`);
    }
    value = (limits as Record<string, unknown>)[label];
  } catch {
    // Fixed text only: a hostile getter must not contribute its own message.
    throw new InvalidContractInputError(`${label} must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidContractInputError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

/**
 * One phase's budget: a fresh canonical instant plus the caller's explicit
 * limit. A throwing or malformed clock becomes a fixed, cause-free failure for
 * that phase - never a raw clock message - and later phases still try their own
 * fresh read.
 */
function phaseBudgetOrNull(
  limit: number,
  dependencies: RunMaintenanceDependencies,
): MaintenanceBudget | null {
  const now = freshInstantOrNull(dependencies);
  if (now === null) {
    return null;
  }
  return requireMaintenanceBudget({ now, limit });
}

/** Fresh canonical instant, or null when the injected clock misbehaves. */
function freshInstantOrNull(dependencies: RunMaintenanceDependencies): IsoInstant | null {
  try {
    return readClockNow(dependencies.clock);
  } catch {
    return null;
  }
}

/**
 * Capture the continuation check once and latch the first stop.
 *
 * The decision is consulted before every phase and before every send. A false
 * or throwing answer latches "stopped" for the rest of the wake, so a deadline
 * exhaustion can never be undone by a later true answer. The captured function
 * reference is the one supplied at the start of the wake.
 */
function latchContinuation(shouldContinue: (() => boolean) | undefined): () => boolean {
  let stopped = false;
  if (shouldContinue === undefined) {
    return () => !stopped;
  }
  const captured = shouldContinue;
  return () => {
    if (stopped) {
      return false;
    }
    let allowed = false;
    try {
      allowed = captured() === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      stopped = true;
    }
    return allowed;
  };
}

async function runRecoveryPhase(
  limit: number,
  continuation: () => boolean,
  dependencies: RunMaintenanceDependencies,
): Promise<RecoveryPhaseReport> {
  if (!continuation()) {
    writeLog(dependencies.logger, phaseSkipped("recovery"));
    return recoveryReport("skipped", "BUDGET_EXHAUSTED", null);
  }

  const budget = phaseBudgetOrNull(limit, dependencies);
  if (budget === null) {
    writeLog(dependencies.logger, phaseFailed("recovery", "CLOCK_UNAVAILABLE"));
    return recoveryReport("failed", "CLOCK_UNAVAILABLE", null);
  }
  try {
    const result: RecoveryResult = await dependencies.publishing.recoverStaleClaims(budget);
    const counts = recoveryCountsOf(result);
    if (counts === null) {
      // A malformed adapter report is a fixed failure, never partially copied.
      writeLog(dependencies.logger, phaseFailed("recovery", "MALFORMED_RESULT"));
      return recoveryReport("failed", "MALFORMED_RESULT", null);
    }
    writeLog(dependencies.logger, phaseCompleted("recovery"));
    return recoveryReport("completed", "COMPLETED", counts);
  } catch {
    // Fixed code only: the port's own error text may carry storage detail.
    writeLog(dependencies.logger, phaseFailed("recovery", "STORE_UNAVAILABLE"));
    return recoveryReport("failed", "STORE_UNAVAILABLE", null);
  }
}

interface RecoveryCounts {
  readonly examined: number;
  readonly staleClaimsMarkedUnknown: number;
  readonly jobsRearmed: number;
  readonly jobsDeadLettered: number;
  readonly skipped: number;
}

function recoveryReport(
  status: MaintenancePhaseStatus,
  code: MaintenancePhaseCode,
  counts: RecoveryCounts | null,
): RecoveryPhaseReport {
  return Object.freeze({
    phase: "recovery" as const,
    status,
    code,
    examined: counts?.examined ?? null,
    staleClaimsMarkedUnknown: counts?.staleClaimsMarkedUnknown ?? null,
    jobsRearmed: counts?.jobsRearmed ?? null,
    jobsDeadLettered: counts?.jobsDeadLettered ?? null,
    skipped: counts?.skipped ?? null,
  });
}

/** Copy five counters, or null when anything is not a real row count. */
function recoveryCountsOf(result: unknown): RecoveryCounts | null {
  try {
    if (typeof result !== "object" || result === null) {
      return null;
    }
    const record = result as Record<string, unknown>;
    const examined = countOf(record["examined"]);
    const staleClaimsMarkedUnknown = countOf(record["staleClaimsMarkedUnknown"]);
    const jobsRearmed = countOf(record["jobsRearmed"]);
    const jobsDeadLettered = countOf(record["jobsDeadLettered"]);
    const skipped = countOf(record["skipped"]);
    if (
      examined === null ||
      staleClaimsMarkedUnknown === null ||
      jobsRearmed === null ||
      jobsDeadLettered === null ||
      skipped === null
    ) {
      return null;
    }
    return Object.freeze({
      examined,
      staleClaimsMarkedUnknown,
      jobsRearmed,
      jobsDeadLettered,
      skipped,
    });
  } catch {
    // A throwing getter is just another malformed report.
    return null;
  }
}

/** Finite, nonnegative, safe integers only; everything else is not a count. */
function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function runCleanupPhase(
  phase: "expired_cleanup" | "finished_collection",
  limit: number,
  call: (budget: MaintenanceBudget) => Promise<CleanupResult>,
  continuation: () => boolean,
  dependencies: RunMaintenanceDependencies,
): Promise<{
  readonly status: MaintenancePhaseStatus;
  readonly code: MaintenancePhaseCode;
  readonly removed: number | null;
}> {
  if (!continuation()) {
    writeLog(dependencies.logger, phaseSkipped(phase));
    return Object.freeze({
      status: "skipped" as const,
      code: "BUDGET_EXHAUSTED" as const,
      removed: null,
    });
  }

  const budget = phaseBudgetOrNull(limit, dependencies);
  if (budget === null) {
    writeLog(dependencies.logger, phaseFailed(phase, "CLOCK_UNAVAILABLE"));
    return Object.freeze({
      status: "failed" as const,
      code: "CLOCK_UNAVAILABLE" as const,
      removed: null,
    });
  }
  try {
    const result = await call(budget);
    const removed = removedOf(result);
    if (removed === null) {
      writeLog(dependencies.logger, phaseFailed(phase, "MALFORMED_RESULT"));
      return Object.freeze({
        status: "failed" as const,
        code: "MALFORMED_RESULT" as const,
        removed: null,
      });
    }
    writeLog(dependencies.logger, phaseCompleted(phase));
    return Object.freeze({
      status: "completed" as const,
      code: "COMPLETED" as const,
      removed,
    });
  } catch {
    // A failed cleanup stays visibly failed: null, never a fabricated zero.
    writeLog(dependencies.logger, phaseFailed(phase, "STORE_UNAVAILABLE"));
    return Object.freeze({
      status: "failed" as const,
      code: "STORE_UNAVAILABLE" as const,
      removed: null,
    });
  }
}

/** Copy the changed-row count, or null when it is not a real count. */
function removedOf(result: unknown): number | null {
  try {
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return countOf((result as Record<string, unknown>)["removed"]);
  } catch {
    return null;
  }
}

async function runDispatchPhase(
  limit: number,
  continuation: () => boolean,
  dependencies: RunMaintenanceDependencies,
): Promise<DispatchPhaseReport> {
  if (!continuation()) {
    writeLog(dependencies.logger, phaseSkipped("dispatch"));
    return dispatchReport("skipped", "BUDGET_EXHAUSTED", null);
  }

  const now = freshInstantOrNull(dependencies);
  if (now === null) {
    writeLog(dependencies.logger, phaseFailed("dispatch", "CLOCK_UNAVAILABLE"));
    return dispatchReport("failed", "CLOCK_UNAVAILABLE", null);
  }
  try {
    const report = await dispatchReadyJobs({
      outbox: dependencies.outbox,
      queue: dependencies.queue,
      now,
      limit,
      // The dispatcher consults the latched check before every send.
      shouldContinue: continuation,
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    });
    const counts = dispatchCountsOf(report);
    if (counts === null) {
      writeLog(dependencies.logger, phaseFailed("dispatch", "MALFORMED_RESULT"));
      return dispatchReport("failed", "MALFORMED_RESULT", null);
    }
    writeLog(dependencies.logger, phaseCompleted("dispatch"));
    return dispatchReport("completed", "COMPLETED", counts);
  } catch {
    writeLog(dependencies.logger, phaseFailed("dispatch", "STORE_UNAVAILABLE"));
    return dispatchReport("failed", "STORE_UNAVAILABLE", null);
  }
}

interface DispatchCounts {
  readonly examined: number;
  readonly sent: number;
  readonly dispatched: number;
  readonly markFailed: number;
  readonly sendFailed: number;
  readonly sendUnknown: number;
  readonly unstarted: number;
}

function dispatchReport(
  status: MaintenancePhaseStatus,
  code: MaintenancePhaseCode,
  counts: DispatchCounts | null,
): DispatchPhaseReport {
  return Object.freeze({
    phase: "dispatch" as const,
    status,
    code,
    examined: counts?.examined ?? null,
    sent: counts?.sent ?? null,
    dispatched: counts?.dispatched ?? null,
    markFailed: counts?.markFailed ?? null,
    sendFailed: counts?.sendFailed ?? null,
    sendUnknown: counts?.sendUnknown ?? null,
    unstarted: counts?.unstarted ?? null,
  });
}

/** Copy the dispatcher counters, or null when any is not a real count. */
function dispatchCountsOf(report: unknown): DispatchCounts | null {
  try {
    if (typeof report !== "object" || report === null) {
      return null;
    }
    const record = report as Record<string, unknown>;
    const examined = countOf(record["examined"]);
    const sent = countOf(record["sent"]);
    const dispatched = countOf(record["dispatched"]);
    const markFailed = countOf(record["markFailed"]);
    const sendFailed = countOf(record["sendFailed"]);
    const sendUnknown = countOf(record["sendUnknown"]);
    const unstarted = countOf(record["unstarted"]);
    if (
      examined === null ||
      sent === null ||
      dispatched === null ||
      markFailed === null ||
      sendFailed === null ||
      sendUnknown === null ||
      unstarted === null
    ) {
      return null;
    }
    return Object.freeze({
      examined,
      sent,
      dispatched,
      markFailed,
      sendFailed,
      sendUnknown,
      unstarted,
    });
  } catch {
    return null;
  }
}

function phaseCompleted(phase: MaintenancePhase): SafeLogEvent {
  return Object.freeze({
    level: "info" as const,
    event: "maintenance_phase_completed",
    fields: { phase, code: "COMPLETED" },
  });
}

function phaseFailed(phase: MaintenancePhase, code: MaintenancePhaseCode): SafeLogEvent {
  return Object.freeze({
    level: "warn" as const,
    event: "maintenance_phase_failed",
    fields: { phase, code },
  });
}

function phaseSkipped(phase: MaintenancePhase): SafeLogEvent {
  return Object.freeze({
    level: "info" as const,
    event: "maintenance_phase_skipped",
    fields: { phase, code: "BUDGET_EXHAUSTED" },
  });
}

function writeLog(logger: Logger | undefined, event: SafeLogEvent): void {
  if (logger === undefined) {
    return;
  }
  try {
    logger.write(event);
  } catch {
    // Swallow: logging must never change a maintenance decision.
  }
}
