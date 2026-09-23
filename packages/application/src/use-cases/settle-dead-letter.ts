/**
 * Standalone portable DLQ consumer.
 *
 * One decoded version-1 envelope is handed to
 * `PublishingStore.settleDeadLetter` with the exact job/entity pair, one
 * canonical observation instant and the fixed transport reason `queue_dlq`.
 * This module can never prepare a publisher, sign a binding, claim an attempt
 * or call a provider: its dependency surface contains none of those ports, and
 * it never re-arms or re-sends anything.
 *
 * Root ruling (design 07 §7): a malformed DLQ message is **quarantined**, not
 * retried. The frozen `ConsumerOutcome` union is unchanged, so the quarantine
 * result is this module's own extension: a fixed code plus fixed metadata, with
 * no domain read/write and nothing parsed out of the invalid input echoed back
 * (no ids, no body, no field names). A runtime treats it as an alert-and-ack;
 * the durable operational alert is runtime scope.
 */

import type { DeadLetterOutcome } from "../contracts/execution.js";
import { decodeQueueEnvelopeV1, type QueueEnvelopeV1 } from "../contracts/outbox.js";
import type {
  ConsumerOutcome,
  ConsumerSettledReason,
} from "../contracts/primitives.js";
import type { SafeLogEvent } from "../contracts/storage.js";
import type { Logger } from "../ports/logger.js";
import type { PublishingStore } from "../ports/publishing-store.js";
import { infrastructureRetry, settled } from "./execution-policy.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

/** Fixed quarantine codes; never derived from the rejected message. */
export type DlqQuarantineReason = "malformed_envelope";

/**
 * What the runtime receives from the DLQ consumer.
 *
 * `quarantined` is an extension of `ConsumerOutcome` for this consumer only:
 * alert with the fixed code and acknowledge, never forward the message to
 * itself and never infer a legacy protocol from it.
 */
export type DlqConsumerOutcome =
  | ConsumerOutcome
  | { readonly kind: "quarantined"; readonly reason: DlqQuarantineReason };

export interface SettleDeadLetterDependencies {
  /** Only the DLQ settlement transaction is needed; nothing else is reachable. */
  readonly publishing: Pick<PublishingStore, "settleDeadLetter">;
  readonly clock: UseCaseClock;
  readonly logger?: Logger;
}

export async function settleDeadLetterMessage(
  message: unknown,
  dependencies: SettleDeadLetterDependencies,
): Promise<DlqConsumerOutcome> {
  const envelope = decodeEnvelopeOrNull(message);
  if (envelope === null) {
    // Quarantine: fixed code, fixed text, zero domain reads/writes. Nothing from
    // the rejected payload - ids, fields or body - is echoed anywhere.
    writeLog(dependencies.logger, {
      level: "error",
      event: "dlq_message_quarantined",
      fields: { code: "malformed_envelope" },
    });
    return Object.freeze({ kind: "quarantined" as const, reason: "malformed_envelope" as const });
  }

  const now = readClockNow(dependencies.clock);

  let outcome: DeadLetterOutcome;
  try {
    outcome = await dependencies.publishing.settleDeadLetter({
      jobId: envelope.jobId,
      publicationId: envelope.entityId,
      now,
      transportReason: "queue_dlq",
    });
  } catch {
    // A bounded metadata write failure is the DLQ runtime's retry decision; it
    // is never answered with a second application-level attempt here, and the
    // raw storage error is dropped rather than logged.
    writeLog(dependencies.logger, {
      level: "warn",
      event: "dlq_settlement_deferred",
      fields: { code: "dlq_metadata_write_failed", jobId: envelope.jobId },
    });
    return infrastructureRetry("dlq_metadata_write_failed");
  }

  return settleOutcome(envelope.jobId, outcome, dependencies.logger);
}

/**
 * Decode with a local boundary guard.
 *
 * The frozen decoder already catches serialisation failures and returns a
 * frozen copy, but a hostile input - a throwing getter or a proxy trap that only
 * misbehaves on `Object.keys`/property reads - can still throw after
 * `JSON.stringify` succeeded. That must become the same fixed quarantine, never
 * an escaping error carrying caller text.
 */
function decodeEnvelopeOrNull(message: unknown): QueueEnvelopeV1 | null {
  try {
    const decoded = decodeQueueEnvelopeV1(message);
    return decoded.kind === "ok" ? decoded.envelope : null;
  } catch {
    return null;
  }
}

/**
 * Map the store's guarded verdict onto the consumer outcome.
 *
 * The store owns every protection: a terminal publication, a live claim, a
 * superseded job, a future due time or a stale claim window are reported back
 * exactly as the store decided them.
 */
function settleOutcome(
  jobId: string,
  outcome: DeadLetterOutcome,
  logger: Logger | undefined,
): ConsumerOutcome {
  const reason: ConsumerSettledReason = (() => {
    switch (outcome.kind) {
      case "dead_lettered":
        return "dead_lettered";
      case "recovered_unknown":
        // A stale claim is recovered conservatively as unknown, never resent.
        return "terminal";
      case "not_found":
        return "stale_job";
      case "recorded":
        switch (outcome.reason) {
          case "terminal":
            return "terminal";
          case "active_claim":
            return "duplicate";
          case "not_due":
            // Transport failure is visible; the current job keeps its due time.
            return "not_due";
          default:
            return "stale_job";
        }
    }
  })();
  writeLog(logger, {
    level: "info",
    event: "dlq_settlement",
    fields: { code: reason, jobId },
  });
  return settled(reason);
}

function writeLog(logger: Logger | undefined, event: SafeLogEvent): void {
  if (logger === undefined) {
    return;
  }
  try {
    logger.write(event);
  } catch {
    // Swallow: logging must never change a settlement decision.
  }
}
