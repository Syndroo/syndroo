import { describe, expect, it } from "vitest";

import {
  ARCHIVE_REDACTION_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  InvalidContractInputError,
  MAX_ARCHIVE_BYTES,
  archiveExpired,
  assertSanitizedArchive,
  isSafeArchiveKey,
  isSafeBlobKey,
  type SanitizedArchive,
} from "../src/index.js";

const validArchive: SanitizedArchive = {
  schemaVersion: ARCHIVE_SCHEMA_VERSION,
  category: "provider_response",
  redactionVersion: ARCHIVE_REDACTION_VERSION,
  platform: "x",
  stage: "response",
  outcome: "failed",
  httpStatus: 503,
  code: "PROVIDER_UNAVAILABLE",
  publicationId: "pub_0001",
  jobId: "job_0001",
  attemptId: "attempt_0001",
  createdAt: "2026-09-23T00:00:00.000Z",
  expiresAt: "2026-10-23T00:00:00.000Z",
};

describe("archive payload allowlist", () => {
  it("accepts the fixed diagnostic schema", () => {
    expect(() => assertSanitizedArchive({ ...validArchive })).not.toThrow();
    expect(isSafeArchiveKey("archive/provider-responses/2026/09/pub_0001/attempt_0001.json")).toBe(
      true,
    );
    expect(isSafeArchiveKey("archive/dlq/2026/09/job_0001.json")).toBe(true);
    expect(isSafeBlobKey("media/posts/post_0001/object_0001")).toBe(true);
  });

  it("rejects any field outside the allowlist without echoing it", () => {
    const withBody = { ...validArchive, body: "raw provider payload" };
    expect(() => assertSanitizedArchive(withBody)).toThrow(InvalidContractInputError);
    try {
      assertSanitizedArchive(withBody);
    } catch (error) {
      expect((error as Error).message).not.toContain("body");
      expect((error as Error).message).not.toContain("raw provider payload");
    }
  });

  it("rejects free-text codes, unknown enums and out-of-range statuses", () => {
    expect(() =>
      assertSanitizedArchive({ ...validArchive, code: "raw text from provider" }),
    ).toThrow(InvalidContractInputError);
    expect(() => assertSanitizedArchive({ ...validArchive, stage: "unknown" })).toThrow(
      InvalidContractInputError,
    );
    expect(() => assertSanitizedArchive({ ...validArchive, outcome: "maybe" })).toThrow(
      InvalidContractInputError,
    );
    expect(() => assertSanitizedArchive({ ...validArchive, platform: "myspace" })).toThrow(
      InvalidContractInputError,
    );
    expect(() => assertSanitizedArchive({ ...validArchive, httpStatus: 99 })).toThrow(
      InvalidContractInputError,
    );
    expect(() => assertSanitizedArchive({ ...validArchive, httpStatus: 600 })).toThrow(
      InvalidContractInputError,
    );
    expect(() => assertSanitizedArchive({ ...validArchive, httpStatus: 200.5 })).toThrow(
      InvalidContractInputError,
    );
  });

  it("accepts only allowlisted diagnostic codes", () => {
    expect(() => assertSanitizedArchive({ ...validArchive, code: "UNKNOWN" })).not.toThrow();
    expect(() =>
      assertSanitizedArchive({ ...validArchive, code: "STORE_UNAVAILABLE" }),
    ).not.toThrow();
    expect(() =>
      assertSanitizedArchive({ ...validArchive, code: "STALLED_RECOVERY_EXHAUSTED" }),
    ).not.toThrow();
    expect(() => assertSanitizedArchive({ ...validArchive, code: null })).not.toThrow();
  });

  it("rejects an uppercase non-allowlisted value without echoing it", () => {
    const sentinel = "SECRET_TOKEN_LEAK_ABC123";
    try {
      assertSanitizedArchive({ ...validArchive, code: sentinel });
      throw new Error("expected the sentinel code to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidContractInputError);
      expect((error as Error).message).toBe(
        "archive code is not an allowlisted diagnostic code",
      );
      expect((error as Error).message).not.toContain(sentinel);
      expect((error as Error).message).not.toContain("SECRET");
    }
  });

  it("only permits the current schema and redaction version", () => {
    expect(() => assertSanitizedArchive({ ...validArchive, redactionVersion: 2 })).toThrow(
      InvalidContractInputError,
    );
    expect(() => assertSanitizedArchive({ ...validArchive, schemaVersion: 0 })).toThrow(
      InvalidContractInputError,
    );
  });

  it("requires canonical instants with expiry after creation", () => {
    expect(() => assertSanitizedArchive({ ...validArchive, createdAt: "2026-09-23T00:00:00Z" })).toThrow(
      InvalidContractInputError,
    );
    expect(() =>
      assertSanitizedArchive({
        ...validArchive,
        createdAt: "2026-10-23T00:00:00.000Z",
        expiresAt: "2026-09-23T00:00:00.000Z",
      }),
    ).toThrow(InvalidContractInputError);
  });

  it("measures the encoded payload instead of trusting a claimed size", () => {
    const oversized = {
      ...validArchive,
      publicationId: "p".repeat(MAX_ARCHIVE_BYTES),
    };
    expect(() => assertSanitizedArchive(oversized)).toThrow(InvalidContractInputError);
  });

  it("treats expiry as authoritative for reads", () => {
    expect(archiveExpired(validArchive, "2026-09-23T00:00:01.000Z")).toBe(false);
    expect(archiveExpired(validArchive, validArchive.expiresAt)).toBe(true);
    expect(archiveExpired(validArchive, "2027-01-01T00:00:00.000Z")).toBe(true);
  });
});
