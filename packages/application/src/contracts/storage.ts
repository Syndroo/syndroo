/**
 * Archive, blob, logger and diagnostics contracts.
 *
 * These are separate semantic ports on purpose: archive diagnostics are
 * bounded and private, blobs are user content infrastructure, and the logger
 * streams structured events to stdout without touching R2.
 */

import { isPlatform, type Platform, type PublishErrorCode } from "@syndroo/core";

import {
  InvalidContractInputError,
  compareInstants,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "./primitives.js";

export const MAX_ARCHIVE_BYTES = 64 * 1024;
export const ARCHIVE_SCHEMA_VERSION = 1;
export const ARCHIVE_REDACTION_VERSION = 1;

export type ArchiveCategory = "provider_response" | "dlq";

export type ArchiveStage = "request" | "response" | "dispatch" | "dlq";

export type ArchiveOutcome =
  | "published"
  | "failed"
  | "unknown"
  | "retry"
  | "rejected"
  | "dead_lettered";

export type ArchiveKey = string;

/**
 * Diagnostic codes that may appear in an archive object.
 *
 * A pattern such as `/^[A-Z0-9_]+$/` would still admit arbitrary uppercase
 * provider text or an uppercased secret, so the boundary uses this fixed
 * allowlist instead. Unknown codes are stored as null, never as free text.
 */
const ARCHIVE_PUBLISH_CODES = [
  "AUTH",
  "RATE_LIMIT",
  "INVALID_CONTENT",
  "PROVIDER_UNAVAILABLE",
  "NETWORK",
  "UNKNOWN",
] as const satisfies readonly PublishErrorCode[];

const ARCHIVE_RUNTIME_CODES = [
  "TIMEOUT",
  "REDIRECT",
  "RESPONSE_TOO_LARGE",
  "ABORTED",
  "INVALID_TARGET",
  "INVALID_ENVELOPE",
  "SEND_FAILED",
  "SEND_UNKNOWN",
  "STORE_UNAVAILABLE",
  "DEAD_LETTERED",
  "STALLED_RECOVERY_EXHAUSTED",
] as const;

export type ArchiveCode =
  | (typeof ARCHIVE_PUBLISH_CODES)[number]
  | (typeof ARCHIVE_RUNTIME_CODES)[number];

export const ARCHIVE_CODES: readonly ArchiveCode[] = Object.freeze([
  ...ARCHIVE_PUBLISH_CODES,
  ...ARCHIVE_RUNTIME_CODES,
]);

// Compile-time guard: adding a core publish error code must extend the list.
type UncoveredPublishCode = Exclude<PublishErrorCode, (typeof ARCHIVE_PUBLISH_CODES)[number]>;
const archivePublishCodesAreComplete: UncoveredPublishCode extends never ? true : never = true;
void archivePublishCodesAreComplete;

/**
 * Allowlisted diagnostic object.
 *
 * Every field is a fixed enum, a bounded number, a normalized code or an
 * internal identifier. Provider text, request ids, headers, bodies and
 * credential material have no representation here at all: an unknown field is
 * rejected at the storage boundary.
 */
export interface SanitizedArchive {
  readonly schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  readonly category: ArchiveCategory;
  readonly redactionVersion: typeof ARCHIVE_REDACTION_VERSION;
  readonly platform: Platform;
  readonly stage: ArchiveStage;
  readonly outcome: ArchiveOutcome;
  /** HTTP status when the diagnostic came from an HTTP step, else null. */
  readonly httpStatus: number | null;
  /** Allowlisted diagnostic code, or null when nothing safe is known. */
  readonly code: ArchiveCode | null;
  readonly publicationId: string | null;
  readonly jobId: string | null;
  readonly attemptId: string | null;
  readonly createdAt: IsoInstant;
  /** Retention deadline; reads at or after this instant return null. */
  readonly expiresAt: IsoInstant;
}

const ARCHIVE_FIELDS: readonly string[] = [
  "schemaVersion",
  "category",
  "redactionVersion",
  "platform",
  "stage",
  "outcome",
  "httpStatus",
  "code",
  "publicationId",
  "jobId",
  "attemptId",
  "createdAt",
  "expiresAt",
];

const ARCHIVE_STAGES: readonly string[] = ["request", "response", "dispatch", "dlq"];

const ARCHIVE_OUTCOMES: readonly string[] = [
  "published",
  "failed",
  "unknown",
  "retry",
  "rejected",
  "dead_lettered",
];

const ARCHIVE_KEY_PREFIXES: readonly string[] = ["archive/provider-responses/", "archive/dlq/"];

const BLOB_KEY_PREFIXES: readonly string[] = ["media/posts/"];

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isWithinPrefix(value: unknown, prefixes: readonly string[]): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    prefixes.some((prefix) => value.startsWith(prefix)) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !hasControlCharacters(value)
  );
}

/** Logical archive keys only; never an R2/S3 endpoint or signed URL. */
export function isSafeArchiveKey(value: unknown): value is ArchiveKey {
  return isWithinPrefix(value, ARCHIVE_KEY_PREFIXES);
}

export function isSafeBlobKey(value: unknown): value is BlobKey {
  return isWithinPrefix(value, BLOB_KEY_PREFIXES);
}

function archiveViolation(message: string): never {
  // Fixed text: a rejected payload may carry secrets, so no field name, value
  // or payload size is ever echoed back.
  throw new InvalidContractInputError(message);
}

/**
 * Re-validate an archive payload at the storage boundary against the
 * allowlist. A producer mistake fails closed instead of persisting anything
 * outside the fixed schema.
 */
export function assertSanitizedArchive(payload: unknown): asserts payload is SanitizedArchive {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    archiveViolation("archive payload must be an allowlisted object");
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ARCHIVE_FIELDS.includes(key)) {
      archiveViolation("archive payload contains a field outside the allowlist");
    }
  }
  for (const field of ARCHIVE_FIELDS) {
    if (!(field in record)) {
      archiveViolation("archive payload is missing a required allowlisted field");
    }
  }
  if (record["schemaVersion"] !== ARCHIVE_SCHEMA_VERSION) {
    archiveViolation("archive schema version is not supported");
  }
  if (record["redactionVersion"] !== ARCHIVE_REDACTION_VERSION) {
    archiveViolation("archive redaction version is not supported");
  }
  if (record["category"] !== "provider_response" && record["category"] !== "dlq") {
    archiveViolation("archive category is not allowlisted");
  }
  if (!isPlatform(record["platform"])) {
    archiveViolation("archive platform is not allowlisted");
  }
  if (!ARCHIVE_STAGES.includes(record["stage"] as string)) {
    archiveViolation("archive stage is not allowlisted");
  }
  if (!ARCHIVE_OUTCOMES.includes(record["outcome"] as string)) {
    archiveViolation("archive outcome is not allowlisted");
  }

  const httpStatus = record["httpStatus"];
  if (
    httpStatus !== null &&
    (!Number.isSafeInteger(httpStatus) ||
      (httpStatus as number) < 100 ||
      (httpStatus as number) > 599)
  ) {
    archiveViolation("archive httpStatus is out of range");
  }

  const code = record["code"];
  if (code !== null && !ARCHIVE_CODES.includes(code as ArchiveCode)) {
    archiveViolation("archive code is not an allowlisted diagnostic code");
  }

  for (const field of ["publicationId", "jobId", "attemptId"] as const) {
    const value = record[field];
    if (value !== null && !isOpaqueId(value)) {
      archiveViolation("archive identifier is not accepted");
    }
  }

  const createdAt = record["createdAt"];
  const expiresAt = record["expiresAt"];
  if (!isIsoInstant(createdAt) || !isIsoInstant(expiresAt)) {
    archiveViolation("archive instants must be canonical UTC instants");
  }
  if (compareInstants(createdAt as string, expiresAt as string) > 0) {
    archiveViolation("archive expiry must not precede creation");
  }

  // Measured, never trusted: the encoded object itself must fit the bound.
  if (utf8ByteLength(JSON.stringify(record)) > MAX_ARCHIVE_BYTES) {
    archiveViolation("archive payload exceeds the size bound");
  }
}

/** Expiry is authoritative for reads: at or past `expiresAt` the object is unavailable. */
export function archiveExpired(
  payload: Pick<SanitizedArchive, "expiresAt">,
  now: IsoInstant,
): boolean {
  return compareInstants(now, payload.expiresAt) >= 0;
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export type BlobKey = string;

export type BinaryBody = Uint8Array | ReadableStream<Uint8Array>;

export interface BlobMetadata {
  readonly contentType: string;
  readonly byteLength: number | null;
  readonly checksum: string | null;
}

export interface StoredBlob {
  readonly key: BlobKey;
  readonly size: number;
  readonly contentType: string;
  readonly checksum: string | null;
}

export interface BlobRead {
  readonly key: BlobKey;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export type SafeLogValue = string | number | boolean | null;

/**
 * Structured, bounded log event. No raw provider body, error message, token or
 * credential may appear in `fields`.
 */
export interface SafeLogEvent {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields?: Readonly<Record<string, SafeLogValue>>;
  readonly errorCode?: string;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface StorageDiagnostic {
  readonly approximateBytes: number | null;
  readonly limitBytes: number | null;
  readonly utilization: number | null;
  readonly reason: string | null;
  readonly observedAt: IsoInstant;
}

/**
 * Read-only diagnostics projection. Mirrors the public wire contract so the
 * HTTP layer cannot drift from the port.
 *
 * `deadLettered` counts *current* transport failures only, deduplicated by
 * publication: a publication that already failed `dead_lettered`, plus a
 * publication still waiting whose current job has seen a DLQ and is awaiting
 * due-time termination. A late DLQ arriving for a published/unknown result or
 * for a superseded job is never counted, so the number reflects live work
 * rather than history.
 *
 * `oldestDueAt`/`oldestAgeSeconds` use exactly the dispatchable predicate of
 * `OutboxStore.listReady`: pending, at or before the observation time, and not
 * already marked by a DLQ. A job that only maintenance may settle is never
 * reported as due work.
 */
export interface SafeDiagnostics {
  readonly observedAt: IsoInstant;
  readonly pendingOutbox: number;
  readonly oldestDueAt: IsoInstant | null;
  readonly oldestAgeSeconds: number | null;
  readonly retryScheduled: number;
  readonly deadLettered: number;
  readonly latestAttemptArchiveFailures: number;
  readonly storage: StorageDiagnostic;
}
