/**
 * Private R2 archive adapter for bounded, redacted diagnostics.
 *
 * The adapter is deliberately narrow: logical keys only (never a URL), the
 * frozen allowlisted payload, a fixed 64 KiB bound, and expiry enforced on
 * reads with an injected clock that must itself be a canonical instant.
 *
 * Payloads are snapshotted into an explicit field projection and validated
 * *after* projection, so a getter or `toJSON` hook on the caller's object
 * cannot change what is serialised.
 */
import {
  ARCHIVE_REDACTION_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  CorruptStoreRecordError,
  InvalidContractInputError,
  MAX_ARCHIVE_BYTES,
  StoreUnavailable,
  archiveExpired,
  assertSanitizedArchive,
  isSafeArchiveKey,
  requireIsoInstant,
  type ArchiveKey,
  type ArchiveStore,
  type IsoInstant,
  type SanitizedArchive,
} from "@syndroo/application";

export interface R2ArchiveStoreOptions {
  readonly bucket: R2Bucket;
  /** Injected clock; expiry is decided by the contract, not by wall time. */
  readonly now: () => IsoInstant;
}

const ARCHIVE_CONTENT_TYPE = "application/json";

export function createR2ArchiveStore(options: R2ArchiveStoreOptions): ArchiveStore {
  const { bucket, now } = options;

  return {
    async put(key: ArchiveKey, payload: SanitizedArchive): Promise<void> {
      requireArchiveKey(key);
      // The whole input boundary is read defensively: a throwing getter,
      // proxy trap or `toJSON` must never escape as its own exception (which
      // could carry caller text), and the object we validate is a snapshot we
      // built ourselves rather than the caller's live object.
      const snapshot = snapshotArchive(payload);
      // Contract validation runs on the snapshot and keeps its own fixed text.
      assertSanitizedArchive(snapshot);
      const encoded = JSON.stringify(snapshot);

      if (new TextEncoder().encode(encoded).byteLength > MAX_ARCHIVE_BYTES) {
        throw new InvalidContractInputError("archive payload exceeds the size bound");
      }

      const written = await guardBucket("archive write failed", () =>
        bucket.put(key, encoded, { httpMetadata: { contentType: ARCHIVE_CONTENT_TYPE } }),
      );

      if (written === null) {
        throw new StoreUnavailable("archive write did not commit");
      }
    },

    async get(key: ArchiveKey): Promise<SanitizedArchive | null> {
      requireArchiveKey(key);

      // Canonical clock first: an invalid instant must never decide expiry.
      const observedAt = requireIsoInstant(now(), "archive clock");
      const object = await guardBucket("archive read failed", () => bucket.get(key));

      if (object === null) {
        return null;
      }

      // Bound the stored object before materialising it.
      if (object.size > MAX_ARCHIVE_BYTES) {
        throw new CorruptStoreRecordError("archived diagnostic object exceeds the size bound");
      }

      const text = await guardBucket("archive read failed", () => object.text());

      if (new TextEncoder().encode(text).byteLength > MAX_ARCHIVE_BYTES) {
        throw new CorruptStoreRecordError("archived diagnostic object exceeds the size bound");
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CorruptStoreRecordError("archived diagnostic object is not readable");
      }

      try {
        assertSanitizedArchive(parsed);
      } catch {
        throw new CorruptStoreRecordError("archived diagnostic object fails its schema");
      }

      // Expired archives read as missing; the object is left to the bucket
      // lifecycle policy.
      return archiveExpired(parsed, observedAt) ? null : parsed;
    },

    async delete(key: ArchiveKey): Promise<void> {
      requireArchiveKey(key);
      await guardBucket("archive delete failed", () => bucket.delete(key));
    },
  };
}

function requireArchiveKey(key: unknown): ArchiveKey {
  if (!isSafeArchiveKey(key)) {
    throw new InvalidContractInputError("archive key must be a bounded logical key");
  }

  return key;
}

/**
 * Copies the allowlisted fields out of the caller's object inside one guarded
 * region. Every failure - an unknown own field, a throwing getter, a proxy
 * trap, a getter that returns a wild value later - becomes the same fixed,
 * cause-free contract error, so no caller text or secret can leak outward.
 */
function snapshotArchive(payload: SanitizedArchive): SanitizedArchive {
  try {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new InvalidContractInputError("archive payload must be an allowlisted object");
    }

    for (const field of Object.getOwnPropertyNames(payload)) {
      if (!ARCHIVE_OWN_FIELDS.includes(field)) {
        throw new InvalidContractInputError(
          "archive payload contains a field outside the allowlist",
        );
      }
    }

    return projectArchive(payload);
  } catch (error) {
    if (
      error instanceof InvalidContractInputError &&
      ARCHIVE_BOUNDARY_MESSAGES.has(error.message)
    ) {
      throw new InvalidContractInputError(error.message);
    }

    throw new InvalidContractInputError("archive payload could not be read safely");
  }
}

/** Messages this adapter itself produces at the input boundary. */
const ARCHIVE_BOUNDARY_MESSAGES = new Set([
  "archive payload must be an allowlisted object",
  "archive payload contains a field outside the allowlist",
]);

const ARCHIVE_OWN_FIELDS: readonly string[] = [
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

/** Fixed safe error text; the bucket's own message and cause never escape. */
async function guardBucket<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new StoreUnavailable(message);
  }
}

/**
 * Explicit projection read one field at a time: only these fields can ever
 * reach the bucket, whatever the input object does afterwards.
 */
function projectArchive(payload: SanitizedArchive): SanitizedArchive {
  return {
    // The caller's values are preserved and then validated: coercing them to
    // the current constants would silently accept an unsupported version.
    schemaVersion: payload.schemaVersion,
    category: payload.category,
    redactionVersion: payload.redactionVersion,
    platform: payload.platform,
    stage: payload.stage,
    outcome: payload.outcome,
    httpStatus: payload.httpStatus,
    code: payload.code,
    publicationId: payload.publicationId,
    jobId: payload.jobId,
    attemptId: payload.attemptId,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
  };
}
