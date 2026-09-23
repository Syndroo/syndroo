/**
 * Shared outbox dispatcher.
 *
 * One function serves both the create fast path and the later scheduled wake.
 * It reads the due jobs the store reports, sends exactly one versioned
 * identity-only envelope per job and records the observed dispatch revision as
 * a post-send guard. Queue acknowledgement, redelivery delays and DLQ movement
 * stay outside this module: the application never rolls back an accepted
 * create and never pretends an accepted send can be aborted.
 */

import {
  envelopeForJob,
  type OutboxJob,
  type QueueEnvelopeV1,
} from "../contracts/outbox.js";
import {
  InvalidContractInputError,
  isOpaqueId,
  requireIsoInstant,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { SafeLogEvent } from "../contracts/storage.js";
import { JobQueueError, type JobQueue } from "../ports/job-queue.js";
import type { Logger } from "../ports/logger.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import { MAX_DISPATCH_JOBS_PER_TICK } from "./shared.js";

/** Fixed transport codes a failed or unconfirmed send may record. */
export type DispatchSendFailureCode = "SEND_FAILED" | "SEND_UNKNOWN";

/**
 * Compact result of one wake. Counts only; identifiers stay in the envelopes
 * and store rows that already carry them.
 */
export interface DispatchReport {
  /** Jobs the store returned as due for this wake. */
  readonly examined: number;
  /** Sends the broker confirmed accepted, whatever the local mark did. */
  readonly sent: number;
  /** Accepted sends whose dispatch mark was applied. */
  readonly dispatched: number;
  /** Accepted sends whose local mark failed or conflicted. */
  readonly markFailed: number;
  /** Sends the broker rejected with a known failure. */
  readonly sendFailed: number;
  /** Sends whose outcome could not be confirmed. */
  readonly sendUnknown: number;
  /** Due jobs left untouched because the run budget was exhausted. */
  readonly unstarted: number;
  /**
   * Jobs this wake durably marked as dispatched. Internal identity is carried
   * only so a fast-path caller can prove its own new jobs were confirmed
   * instead of being crowded out by an older backlog.
   */
  readonly confirmedJobIds: readonly string[];
}

export const EMPTY_DISPATCH_REPORT: DispatchReport = Object.freeze({
  examined: 0,
  sent: 0,
  dispatched: 0,
  markFailed: 0,
  sendFailed: 0,
  sendUnknown: 0,
  unstarted: 0,
  confirmedJobIds: Object.freeze([]),
});

/**
 * True when this wake left recoverable work for a later wake: untouched due
 * jobs, a send that failed or is unconfirmed, or an accepted send whose local
 * mark did not apply (the job is durably pending again and a later wake must
 * retry it).
 */
export function dispatchReportDeferred(report: DispatchReport): boolean {
  return (
    report.unstarted > 0 ||
    report.sendFailed > 0 ||
    report.sendUnknown > 0 ||
    report.markFailed > 0
  );
}

export interface DispatchReadyJobsInput {
  readonly outbox: OutboxStore;
  readonly queue: JobQueue;
  readonly now: IsoInstant;
  /** Optional lower run budget; values above the tick cap are capped. */
  readonly limit?: number;
  /**
   * Optional deadline/budget predicate consulted before every new send. When it
   * returns false the dispatcher stops starting operations and reports the due
   * jobs it did not touch. Already accepted sends are never re-sent.
   */
  readonly shouldContinue?: () => boolean;
  readonly logger?: Logger;
  readonly traceId?: string;
}

export async function dispatchReadyJobs(
  input: DispatchReadyJobsInput,
): Promise<DispatchReport> {
  requireIsoInstant(input.now, "dispatch now");
  const requestedLimit = input.limit ?? MAX_DISPATCH_JOBS_PER_TICK;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new InvalidContractInputError("dispatch limit must be a positive safe integer");
  }
  const limit = Math.min(requestedLimit, MAX_DISPATCH_JOBS_PER_TICK);
  if (input.shouldContinue !== undefined && typeof input.shouldContinue !== "function") {
    throw new InvalidContractInputError("shouldContinue must be a function");
  }
  if (input.traceId !== undefined && !isOpaqueId(input.traceId, 64)) {
    throw new InvalidContractInputError("dispatch traceId must be a bounded opaque identifier");
  }

  // The store owns due/order/cap semantics; a lower limit only narrows it.
  const jobs = await input.outbox.listReady({ now: input.now, limit });

  let sent = 0;
  let dispatched = 0;
  let markFailed = 0;
  let sendFailed = 0;
  let sendUnknown = 0;
  let unstarted = 0;
  const confirmedJobIds: string[] = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (job === undefined) {
      continue;
    }
    if (input.shouldContinue !== undefined && !input.shouldContinue()) {
      unstarted = jobs.length - index;
      writeDispatchLog(input.logger, {
        level: "info",
        event: "outbox_dispatch_deferred",
        fields: { unstarted },
      });
      break;
    }

    const envelope: QueueEnvelopeV1 = envelopeForJob(job, input.now, input.traceId);
    try {
      await input.queue.send(envelope);
    } catch (error) {
      // One attempt per job per wake: a failed or unconfirmed send is left
      // pending for the next normal wake and is never retried in this tick.
      const code = classifySendFailure(error);
      if (code === "SEND_FAILED") {
        sendFailed += 1;
      } else {
        sendUnknown += 1;
      }
      await recordFailedDispatch(input, job, code);
      writeDispatchLog(input.logger, {
        level: "warn",
        event: code === "SEND_FAILED" ? "outbox_dispatch_send_failed" : "outbox_dispatch_send_unknown",
        fields: { jobId: job.id, dispatchRevision: job.dispatchRevision, code },
      });
      continue;
    }

    sent += 1;
    try {
      const mark = await input.outbox.recordDispatch({
        jobId: job.id,
        dispatchRevision: job.dispatchRevision,
        now: input.now,
        outcome: { kind: "dispatched" },
      });
      if (mark.kind === "applied") {
        dispatched += 1;
        confirmedJobIds.push(job.id);
      } else {
        // The producer's mark lost to a newer rearm/cancel intent. The message
        // is already accepted, so it stays a duplicate the consumer settles.
        markFailed += 1;
        writeDispatchLog(input.logger, {
          level: "warn",
          event: "outbox_dispatch_mark_conflict",
          fields: {
            jobId: job.id,
            dispatchRevision: job.dispatchRevision,
            code: mark.kind === "conflict" ? mark.reason : "already_applied",
          },
        });
      }
    } catch {
      // An accepted send with a lost mark must never be sent a second time in
      // the same invocation; the duplicate is the consumer's problem to settle.
      markFailed += 1;
      writeDispatchLog(input.logger, {
        level: "warn",
        event: "outbox_dispatch_mark_failed",
        fields: {
          jobId: job.id,
          dispatchRevision: job.dispatchRevision,
          code: "STORE_UNAVAILABLE",
        },
      });
    }
  }

  return Object.freeze({
    examined: jobs.length,
    sent,
    dispatched,
    markFailed,
    sendFailed,
    sendUnknown,
    unstarted,
    confirmedJobIds: Object.freeze([...confirmedJobIds]),
  });
}

/**
 * Only an explicitly classified broker rejection counts as a known failure.
 * Anything else may already have been accepted, so it is reported unknown.
 */
function classifySendFailure(error: unknown): DispatchSendFailureCode {
  if (error instanceof JobQueueError) {
    return error.certainty === "failed" ? "SEND_FAILED" : "SEND_UNKNOWN";
  }
  return "SEND_UNKNOWN";
}

async function recordFailedDispatch(
  input: DispatchReadyJobsInput,
  job: OutboxJob,
  code: DispatchSendFailureCode,
): Promise<void> {
  try {
    await input.outbox.recordDispatch({
      jobId: job.id,
      dispatchRevision: job.dispatchRevision,
      now: input.now,
      outcome: { kind: "failed", errorCode: code },
    });
  } catch {
    // Transport metadata is best effort: the job stays pending either way and
    // the next wake retries the same persisted job identity.
  }
}

/**
 * Best-effort structured logging. A logging failure never changes the report,
 * and only fixed codes plus internal identifiers ever reach a sink.
 */
function writeDispatchLog(logger: Logger | undefined, event: SafeLogEvent): void {
  if (logger === undefined) {
    return;
  }
  try {
    logger.write(event);
  } catch {
    // Swallow: observability must not break dispatch.
  }
}
