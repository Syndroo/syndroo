/**
 * Shared fixtures for the 0.5.0 crypto/R2 suites.
 *
 * The keys below are synthetic test values generated for this repository; they
 * are not deployment secrets and are never read from `.dev.vars`.
 */
import type { CipherContext, SanitizedArchive } from "@syndroo/application";

/** 32 bytes of the byte value 0x2a, canonical padded base64 (fixture only). */
export const TEST_CIPHER_KEY = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=";
export const TEST_CIPHER_KEY_ID = "k1";
/** A different 32-byte key (0x42...), used to prove wrong-key rejection. */
export const TEST_OTHER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
/** 48 bytes of 0x43, used for the binding signer (longer than the 32-byte minimum). */
export const TEST_BINDING_KEY =
  "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0ND";

export const TEST_CONTEXT: CipherContext = {
  purpose: "active_slot",
  recordId: "slot-bluesky",
  platform: "bluesky",
  payloadSchemaVersion: 1,
  payloadRevision: 1,
};

export function contextWith(overrides: Partial<CipherContext>): CipherContext {
  return { ...TEST_CONTEXT, ...overrides };
}

export function archivePayload(overrides: Partial<SanitizedArchive> = {}): SanitizedArchive {
  return {
    schemaVersion: 1,
    category: "provider_response",
    redactionVersion: 1,
    platform: "threads",
    stage: "response",
    outcome: "failed",
    httpStatus: 503,
    code: "PROVIDER_UNAVAILABLE",
    publicationId: "pub-1",
    jobId: null,
    attemptId: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    expiresAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

export const ARCHIVE_KEY = "archive/provider-responses/2026/09/pub-1/attempt-1.json";
export const DLQ_ARCHIVE_KEY = "archive/dlq/2026/09/job-1.json";
export const BLOB_KEY = "media/posts/post-1/object-1";

/** R2 bindings are not part of this project's generated Worker Env type. */
export interface StorageBindings {
  readonly ARCHIVE_BUCKET: R2Bucket;
  readonly MEDIA_BUCKET: R2Bucket;
}
