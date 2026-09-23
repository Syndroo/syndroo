import { describe, expect, it } from "vitest";

import { PublishError, type PublishErrorCode } from "@syndroo/core";

import { assertSanitizedArchive, type SafeLogEvent } from "../src/index.js";
import {
  archiveCodeOf,
  archiveMetadataForFailure,
  archiveMetadataForPublished,
  decideFailureOutcome,
  infrastructureRetry,
  normalizePublishFailure,
  planArchive,
  plannedArchiveKey,
  safeProviderIdentifier,
  settled,
  type PublishFailureView,
} from "../src/use-cases/execution-policy.js";
import { FIXTURE_NOW, instant } from "../src/testing/index.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

function view(overrides: Partial<PublishFailureView> = {}): PublishFailureView {
  return {
    code: "RATE_LIMIT",
    ambiguous: false,
    retryAfterAt: null,
    ...overrides,
  };
}

describe("outcome helpers", () => {
  it("returns frozen consumer outcomes", () => {
    const done = settled("executed");
    expect(done).toEqual({ kind: "settled", reason: "executed" });
    expect(Object.isFrozen(done)).toBe(true);
    const deferred = infrastructureRetry("preparation_deferred");
    expect(deferred).toEqual({
      kind: "infrastructure_retry",
      reason: "preparation_deferred",
    });
    expect(Object.isFrozen(deferred)).toBe(true);
  });
});

describe("failure policy", () => {
  it("retries a safe unambiguous failure on the default schedule", () => {
    const first = decideFailureOutcome({ failure: view(), attempts: 1, now: FIXTURE_NOW });
    expect(first).toEqual({
      kind: "retry",
      retryAt: instant(60_000),
      nextAttemptNo: 2,
    });

    const second = decideFailureOutcome({ failure: view(), attempts: 2, now: FIXTURE_NOW });
    expect(second).toEqual({
      kind: "retry",
      retryAt: instant(120_000),
      nextAttemptNo: 3,
    });
  });

  it("honours a later provider hint without truncating it", () => {
    const hint = instant(3 * 24 * 60 * 60_000);
    const decision = decideFailureOutcome({
      failure: view({ code: "RATE_LIMIT", retryAfterAt: hint }),
      attempts: 1,
      now: FIXTURE_NOW,
    });
    expect(decision).toEqual({ kind: "retry", retryAt: hint, nextAttemptNo: 2 });
  });

  it("ignores a hint that is already in the past", () => {
    const decision = decideFailureOutcome({
      failure: view({ retryAfterAt: instant(-1) }),
      attempts: 1,
      now: FIXTURE_NOW,
    });
    expect(decision).toEqual({ kind: "retry", retryAt: instant(60_000), nextAttemptNo: 2 });
  });

  it("closes an exhausted safe budget as attempts_exhausted", () => {
    const decision = decideFailureOutcome({
      failure: view({ code: "PROVIDER_UNAVAILABLE" }),
      attempts: 3,
      now: FIXTURE_NOW,
    });
    expect(decision).toEqual({
      kind: "terminal",
      terminalReason: "attempts_exhausted",
      errorCode: "PROVIDER_UNAVAILABLE",
      errorAmbiguous: false,
    });
  });

  it("never retries ambiguous or unknown evidence", () => {
    const ambiguous = decideFailureOutcome({
      failure: view({ code: "NETWORK", ambiguous: true }),
      attempts: 1,
      now: FIXTURE_NOW,
    });
    expect(ambiguous).toEqual({
      kind: "terminal",
      terminalReason: "unknown",
      errorCode: "NETWORK",
      errorAmbiguous: true,
    });

    // Even an explicitly non-ambiguous UNKNOWN cannot become a clean rejection.
    const unknown = decideFailureOutcome({
      failure: view({ code: "UNKNOWN", ambiguous: false }),
      attempts: 1,
      now: FIXTURE_NOW,
    });
    expect(unknown).toEqual({
      kind: "terminal",
      terminalReason: "unknown",
      errorCode: "UNKNOWN",
      errorAmbiguous: true,
    });
  });

  it("rejects an unambiguous non-safe code as provider_rejected", () => {
    const decision = decideFailureOutcome({
      failure: view({ code: "AUTH" }),
      attempts: 1,
      now: FIXTURE_NOW,
    });
    expect(decision).toEqual({
      kind: "terminal",
      terminalReason: "provider_rejected",
      errorCode: "AUTH",
      errorAmbiguous: false,
    });
  });

  it("rejects a non-positive attempt count as a contract error", () => {
    expect(() =>
      decideFailureOutcome({ failure: view(), attempts: 0, now: FIXTURE_NOW }),
    ).toThrow("attempts must be a positive safe integer");
  });
});

describe("provider failure normalization", () => {
  it("reduces non-typed throws to an ambiguous UNKNOWN", () => {
    for (const thrown of [new Error("boom"), "provider said no", null, undefined, { code: "NETWORK", ambiguous: false }]) {
      expect(normalizePublishFailure(thrown)).toEqual({
        code: "UNKNOWN",
        ambiguous: true,
        retryAfterAt: null,
      });
    }
  });

  it("keeps an allowlisted code with an explicit false flag", () => {
    const typed = new PublishError("rate limited", "RATE_LIMIT", false, {
      retryAfterAt: instant(600_000),
    });
    expect(normalizePublishFailure(typed)).toEqual({
      code: "RATE_LIMIT",
      ambiguous: false,
      retryAfterAt: instant(600_000),
    });
  });

  it("forces ambiguity for UNKNOWN, forged codes and malformed flags", () => {
    const cases: readonly PublishError[] = [
      new PublishError("unknown", "UNKNOWN", false),
      new PublishError("forged", "BOGUS" as unknown as PublishErrorCode, false),
      new PublishError("flag", "NETWORK", "yes" as unknown as boolean),
      new PublishError("flag2", "RATE_LIMIT", 1 as unknown as boolean),
    ];
    for (const error of cases) {
      const normalized = normalizePublishFailure(error);
      expect(normalized.ambiguous).toBe(true);
      if (error.code === "UNKNOWN" || error.code === ("BOGUS" as PublishErrorCode)) {
        expect(normalized.code).toBe("UNKNOWN");
      }
    }
    // The forged-code case must also reduce to UNKNOWN rather than a raw value.
    expect(
      normalizePublishFailure(new PublishError("forged", "BOGUS" as unknown as PublishErrorCode, false))
        .code,
    ).toBe("UNKNOWN");
  });

  it("drops non-canonical retry hints and never reads provider text", () => {
    const sentinel = "SENTINEL-provider-body-4c17";
    const withBadHint = new PublishError(`failed ${sentinel}`, "NETWORK", false, {
      retryAfterAt: "2026-09-23T09:00:00+09:00",
    });
    const normalized = normalizePublishFailure(withBadHint);
    expect(normalized).toEqual({ code: "NETWORK", ambiguous: false, retryAfterAt: null });
    expect(JSON.stringify(normalized)).not.toContain(sentinel);
  });

  it("fails closed when reading a typed error throws", () => {
    const sentinel = "SENTINEL-throwing-getter-9a02";
    const hostile = new PublishError("safe", "NETWORK", false);
    Object.defineProperty(hostile, "retryAfterAt", {
      configurable: true,
      get(): never {
        throw new Error(`leaked ${sentinel}`);
      },
    });
    const normalized = normalizePublishFailure(hostile);
    expect(normalized).toEqual({ code: "UNKNOWN", ambiguous: true, retryAfterAt: null });
    expect(JSON.stringify(normalized)).not.toContain(sentinel);
    // Unknown evidence is terminal, never retried.
    expect(
      decideFailureOutcome({ failure: normalized, attempts: 1, now: FIXTURE_NOW }).kind,
    ).toBe("terminal");
  });
});

describe("archive planning", () => {
  it("plans a deterministic allowlisted object with 30-day retention", () => {
    const plan = planArchive({
      now: FIXTURE_NOW,
      publicationId: "pub_1",
      jobId: "job_1",
      attemptId: "attempt_1",
      platform: "x",
      outcome: "published",
      code: null,
      httpStatus: null,
    });
    expect(plan.key).toBe("archive/provider-responses/2026/09/pub_1/attempt_1.json");
    expect(plan.key).toBe(
      plannedArchiveKey({
        now: FIXTURE_NOW,
        publicationId: "pub_1",
        attemptId: "attempt_1",
      }),
    );
    expect(() => assertSanitizedArchive(plan.payload)).not.toThrow();
    expect(plan.payload).toEqual({
      schemaVersion: 1,
      category: "provider_response",
      redactionVersion: 1,
      platform: "x",
      stage: "response",
      outcome: "published",
      httpStatus: null,
      code: null,
      publicationId: "pub_1",
      jobId: "job_1",
      attemptId: "attempt_1",
      createdAt: FIXTURE_NOW,
      expiresAt: instant(THIRTY_DAYS_MS),
    });
    expect(Object.isFrozen(plan.payload)).toBe(true);
  });

  it("allowlists archive diagnostic codes", () => {
    expect(archiveCodeOf("RATE_LIMIT")).toBe("RATE_LIMIT");
    expect(archiveCodeOf("SEND_UNKNOWN")).toBe("SEND_UNKNOWN");
    expect(archiveCodeOf("NOT_A_CODE")).toBe(null);
    expect(archiveCodeOf(42)).toBe(null);
  });

  it("maps decisions onto archive metadata", () => {
    expect(archiveMetadataForPublished()).toEqual({ outcome: "published", code: null });
    expect(
      archiveMetadataForFailure(view({ code: "RATE_LIMIT" }), {
        kind: "retry",
        retryAt: instant(60_000),
        nextAttemptNo: 2,
      }),
    ).toEqual({ outcome: "retry", code: "RATE_LIMIT" });
    expect(
      archiveMetadataForFailure(view({ code: "AUTH" }), {
        kind: "terminal",
        terminalReason: "provider_rejected",
        errorCode: "AUTH",
        errorAmbiguous: false,
      }),
    ).toEqual({ outcome: "rejected", code: "AUTH" });
    expect(
      archiveMetadataForFailure(view({ code: "NETWORK", ambiguous: true }), {
        kind: "terminal",
        terminalReason: "unknown",
        errorCode: "NETWORK",
        errorAmbiguous: true,
      }),
    ).toEqual({ outcome: "unknown", code: "NETWORK" });
    expect(
      archiveMetadataForFailure(view({ code: "PROVIDER_UNAVAILABLE" }), {
        kind: "terminal",
        terminalReason: "attempts_exhausted",
        errorCode: "PROVIDER_UNAVAILABLE",
        errorAmbiguous: false,
      }),
    ).toEqual({ outcome: "failed", code: "PROVIDER_UNAVAILABLE" });
  });

  it("bounds stored provider identifiers", () => {
    expect(safeProviderIdentifier("https://example.test/p/1")).toBe("https://example.test/p/1");
    expect(safeProviderIdentifier("with\nnewline")).toBe(null);
    expect(safeProviderIdentifier(`bad\u0000value`)).toBe(null);
    expect(safeProviderIdentifier("")).toBe(null);
    expect(safeProviderIdentifier("x".repeat(2049))).toBe(null);
    expect(safeProviderIdentifier(42)).toBe(null);
  });
});

describe("log-shaped values", () => {
  it("only produces allowlisted log field values", () => {
    const event: SafeLogEvent = {
      level: "info",
      event: "execution_skipped",
      fields: { code: "stale_job", jobId: "job_1" },
    };
    expect(JSON.stringify(event)).toBe(
      '{"level":"info","event":"execution_skipped","fields":{"code":"stale_job","jobId":"job_1"}}',
    );
  });
});
