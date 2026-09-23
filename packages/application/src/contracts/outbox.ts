/**
 * Outbox job identity and the versioned queue envelope.
 *
 * `OutboxJob.id` is one scheduled Publisher execution opportunity:
 * infrastructure redelivery, duplicate dispatches and stalled recovery reuse
 * the same job id, while a safe business retry creates a new job.
 */

import {
  InvalidContractInputError,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "./primitives.js";

/** Project-conservative envelope bound; not a substitute for the 128KiB platform limit. */
export const MAX_QUEUE_ENVELOPE_BYTES = 2048;

export const OUTBOX_PAYLOAD_VERSION = 1;

export type OutboxJobKind = "delivery.execute";

export type OutboxJobStatus = "pending" | "dispatched" | "cancelled";

/**
 * Why an outbox job's transport failed. Always compact and safe; never a raw
 * provider or storage message.
 */
export type TransportReason =
  | "queue_dlq"
  | "future_dlq"
  | "stalled_recovery_exhausted";

export interface OutboxJob {
  readonly id: string;
  readonly kind: OutboxJobKind;
  readonly payloadVersion: typeof OUTBOX_PAYLOAD_VERSION;
  /** Existing `Publication.id`; never the Post id. */
  readonly aggregateId: string;
  /** Expected next Publisher sequence number, 1..3. Never broker attempt count. */
  readonly attemptNo: number;
  readonly availableAt: IsoInstant;
  readonly status: OutboxJobStatus;
  /** CAS version for dispatch intent, not a provider attempt counter. */
  readonly dispatchRevision: number;
  readonly dispatchAttemptCount: number;
  readonly lastDispatchErrorCode: string | null;
  readonly dispatchedAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  readonly recoveryCount: number;
  readonly recoveryAfter: IsoInstant | null;
  readonly dlqSeenAt: IsoInstant | null;
  readonly transportReason: TransportReason | null;
}

/** A job identity the application decides to persist. */
export interface NewOutboxJobRecord {
  readonly id: string;
  readonly kind: OutboxJobKind;
  readonly aggregateId: string;
  readonly attemptNo: number;
  readonly availableAt: IsoInstant;
}

export interface QueueEnvelopeV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly kind: OutboxJobKind;
  /** Existing `Publication.id`. */
  readonly entityId: string;
  /** Diagnostic only; never used to decide whether a job is due. */
  readonly enqueuedAt: IsoInstant;
  readonly traceId?: string;
}

export type EnvelopeInvalidReason =
  | "not_an_object"
  | "oversized"
  | "unknown_fields"
  | "unsupported_version"
  | "unsupported_kind"
  | "missing_field"
  | "invalid_id"
  | "invalid_instant";

export type EnvelopeDecodeResult =
  | { readonly kind: "ok"; readonly envelope: QueueEnvelopeV1 }
  | {
      readonly kind: "invalid";
      readonly reason: EnvelopeInvalidReason;
      readonly detail: string;
    };

const ALLOWED_ENVELOPE_KEYS: readonly string[] = [
  "version",
  "jobId",
  "kind",
  "entityId",
  "enqueuedAt",
  "traceId",
];

function envelopeInvalid(
  reason: EnvelopeInvalidReason,
  detail: string,
): EnvelopeDecodeResult {
  return Object.freeze({ kind: "invalid" as const, reason, detail });
}

/**
 * Fixed, payload-independent diagnostics.
 *
 * A rejected envelope may carry credential or body material, so nothing from
 * the message (field names, values, counts) is ever echoed into the reason or
 * detail text.
 */
const ENVELOPE_DETAIL: Readonly<Record<EnvelopeInvalidReason, string>> = Object.freeze({
  not_an_object: "envelope must be a plain object",
  oversized: "envelope exceeds the project size bound",
  unknown_fields: "envelope has unexpected fields",
  unsupported_version: "envelope version is not supported",
  unsupported_kind: "envelope kind is not supported",
  missing_field: "envelope is missing a required field",
  invalid_id: "envelope identifier is not accepted",
  invalid_instant: "envelope instant is not a canonical UTC instant",
});

function invalidEnvelope(reason: EnvelopeInvalidReason): EnvelopeDecodeResult {
  const detail = ENVELOPE_DETAIL[reason];
  return envelopeInvalid(reason, detail);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Validate a decoded queue message.
 *
 * Rules: object only, no legacy bare publication id, exactly version 1 and
 * kind `delivery.execute`, bounded opaque ids, canonical UTC instants, no
 * unknown fields (a payload carrying credential/body material must never be
 * silently accepted) and a total project bound of 2KiB.
 */
export function decodeQueueEnvelopeV1(value: unknown): EnvelopeDecodeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidEnvelope("not_an_object");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalidEnvelope("not_an_object");
  }
  if (utf8ByteLength(serialized) > MAX_QUEUE_ENVELOPE_BYTES) {
    return invalidEnvelope("oversized");
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !ALLOWED_ENVELOPE_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    return invalidEnvelope("unknown_fields");
  }

  if (record.version !== OUTBOX_PAYLOAD_VERSION) {
    return invalidEnvelope("unsupported_version");
  }
  if (record.kind !== "delivery.execute") {
    return invalidEnvelope("unsupported_kind");
  }

  for (const field of ["jobId", "entityId", "enqueuedAt"] as const) {
    if (!(field in record)) {
      return invalidEnvelope("missing_field");
    }
  }

  const jobId = record["jobId"];
  const entityId = record["entityId"];
  const enqueuedAt = record["enqueuedAt"];
  const traceId = record["traceId"];

  if (!isOpaqueId(jobId)) {
    return invalidEnvelope("invalid_id");
  }
  if (!isOpaqueId(entityId)) {
    return invalidEnvelope("invalid_id");
  }
  if (!isIsoInstant(enqueuedAt)) {
    return invalidEnvelope("invalid_instant");
  }
  if (traceId !== undefined && !isOpaqueId(traceId, 64)) {
    return invalidEnvelope("invalid_id");
  }

  return Object.freeze({
    kind: "ok" as const,
    envelope: Object.freeze({
      version: OUTBOX_PAYLOAD_VERSION,
      jobId,
      kind: "delivery.execute" as const,
      entityId,
      enqueuedAt,
      ...(traceId === undefined ? {} : { traceId }),
    }),
  });
}

/**
 * Serialize an envelope after validating it. Throws `InvalidContractInputError`
 * when the envelope would be rejected on the consumer side.
 */
export function encodeQueueEnvelopeV1(envelope: QueueEnvelopeV1): string {
  const decoded = decodeQueueEnvelopeV1(envelope);
  if (decoded.kind === "invalid") {
    throw new InvalidContractInputError(`invalid queue envelope: ${decoded.detail}`);
  }
  return JSON.stringify(decoded.envelope);
}

export function queueEnvelopeByteLength(envelope: QueueEnvelopeV1): number {
  return utf8ByteLength(encodeQueueEnvelopeV1(envelope));
}

export function envelopeForJob(
  job: Pick<OutboxJob, "id" | "aggregateId">,
  enqueuedAt: IsoInstant,
  traceId?: string,
): QueueEnvelopeV1 {
  return Object.freeze({
    version: OUTBOX_PAYLOAD_VERSION,
    jobId: job.id,
    kind: "delivery.execute" as const,
    entityId: job.aggregateId,
    enqueuedAt,
    ...(traceId === undefined ? {} : { traceId }),
  });
}

// ---------------------------------------------------------------------------
// Outbox port inputs/results
// ---------------------------------------------------------------------------

export interface ReadyQuery {
  readonly now: IsoInstant;
  readonly limit: number;
}

export type DispatchConflictReason =
  | "not_found"
  | "revision_mismatch"
  | "not_pending"
  | "cancelled";

export interface DispatchObservation {
  readonly jobId: string;
  /** Observed `dispatchRevision`; a late mark must not resurrect newer intent. */
  readonly dispatchRevision: number;
  readonly now: IsoInstant;
  readonly outcome:
    | { readonly kind: "dispatched" }
    | { readonly kind: "failed"; readonly errorCode: string };
}

export type RearmConflictReason =
  | "not_found"
  | "not_current_job"
  | "terminal"
  | "active_claim"
  | "dlq_seen"
  | "not_due"
  | "revision_mismatch";

export interface RearmCondition {
  readonly jobId: string;
  readonly publicationId: string;
  readonly now: IsoInstant;
  /**
   * `early_message` is a legitimate early delivery and only restores dispatch
   * intent. `stalled_transport` consumes the bounded recovery budget.
   */
  readonly reason: "early_message" | "stalled_transport";
}

export type RearmResult =
  | { readonly kind: "rearmed"; readonly recoveryCount: number; readonly dispatchRevision: number }
  | { readonly kind: "exhausted"; readonly recoveryCount: number }
  | { readonly kind: "conflict"; readonly reason: RearmConflictReason };
