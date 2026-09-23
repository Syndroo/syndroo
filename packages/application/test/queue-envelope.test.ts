import { describe, expect, it } from "vitest";

import {
  MAX_QUEUE_ENVELOPE_BYTES,
  decodeQueueEnvelopeV1,
  encodeQueueEnvelopeV1,
  envelopeForJob,
  queueEnvelopeByteLength,
  type QueueEnvelopeV1,
} from "../src/index.js";

const validEnvelope: QueueEnvelopeV1 = {
  version: 1,
  jobId: "job_0001",
  kind: "delivery.execute",
  entityId: "pub_0001",
  enqueuedAt: "2026-09-23T00:00:00.000Z",
  traceId: "trace_0001",
};

describe("queue envelope v1", () => {
  it("round-trips a valid envelope and stays inside the project bound", () => {
    const decoded = decodeQueueEnvelopeV1({ ...validEnvelope });
    expect(decoded.kind).toBe("ok");
    const serialized = encodeQueueEnvelopeV1(validEnvelope);
    expect(JSON.parse(serialized)).toEqual(validEnvelope);
    expect(queueEnvelopeByteLength(validEnvelope)).toBeLessThan(MAX_QUEUE_ENVELOPE_BYTES);
    expect(envelopeForJob({ id: "job_0001", aggregateId: "pub_0001" }, validEnvelope.enqueuedAt))
      .toEqual({
        version: 1,
        jobId: "job_0001",
        kind: "delivery.execute",
        entityId: "pub_0001",
        enqueuedAt: validEnvelope.enqueuedAt,
      });
  });

  it("rejects non-objects, arrays and legacy bare publication ids", () => {
    expect(decodeQueueEnvelopeV1("pub_0001")).toMatchObject({ kind: "invalid", reason: "not_an_object" });
    expect(decodeQueueEnvelopeV1(null)).toMatchObject({ kind: "invalid", reason: "not_an_object" });
    expect(decodeQueueEnvelopeV1([])).toMatchObject({ kind: "invalid", reason: "not_an_object" });
    expect(decodeQueueEnvelopeV1(42)).toMatchObject({ kind: "invalid", reason: "not_an_object" });
  });

  it("rejects unsupported versions and kinds without echoing the payload", () => {
    const version = decodeQueueEnvelopeV1({ ...validEnvelope, version: 2 });
    expect(version).toMatchObject({ kind: "invalid", reason: "unsupported_version" });
    const kind = decodeQueueEnvelopeV1({ ...validEnvelope, kind: "delivery.unknown" });
    expect(kind).toMatchObject({ kind: "invalid", reason: "unsupported_kind" });
  });

  it("never echoes untrusted field names or values into diagnostics", () => {
    const secret = "Bearer supersecret-token";
    const unknownField = decodeQueueEnvelopeV1({ ...validEnvelope, [secret]: secret });
    const versionEcho = decodeQueueEnvelopeV1({ ...validEnvelope, version: secret });
    const kindEcho = decodeQueueEnvelopeV1({ ...validEnvelope, kind: secret });
    const missing = decodeQueueEnvelopeV1({ version: 1, kind: "delivery.execute" });

    expect(unknownField).toMatchObject({
      kind: "invalid",
      reason: "unknown_fields",
      detail: "envelope has unexpected fields",
    });
    expect(versionEcho).toMatchObject({
      reason: "unsupported_version",
      detail: "envelope version is not supported",
    });
    expect(kindEcho).toMatchObject({
      reason: "unsupported_kind",
      detail: "envelope kind is not supported",
    });
    expect(missing).toMatchObject({
      reason: "missing_field",
      detail: "envelope is missing a required field",
    });
    for (const result of [unknownField, versionEcho, kindEcho, missing]) {
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).not.toContain(secret);
        expect(result.detail).not.toContain("supersecret");
      }
    }
  });

  it("rejects malformed identifiers and instants", () => {
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, jobId: "" })).toMatchObject({
      reason: "invalid_id",
    });
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, jobId: "x".repeat(129) })).toMatchObject({
      reason: "invalid_id",
    });
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, jobId: "bad id" })).toMatchObject({
      reason: "invalid_id",
    });
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, entityId: 12 })).toMatchObject({
      reason: "invalid_id",
    });
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, traceId: "trace id" })).toMatchObject({
      reason: "invalid_id",
    });
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, enqueuedAt: "2026-09-23T00:00:00Z" }))
      .toMatchObject({ reason: "invalid_instant" });
    expect(decodeQueueEnvelopeV1({ ...validEnvelope, enqueuedAt: "2026-02-30T00:00:00.000Z" }))
      .toMatchObject({ reason: "invalid_instant" });
  });

  it("rejects oversized envelopes", () => {
    const oversized = decodeQueueEnvelopeV1({
      ...validEnvelope,
      traceId: "t".repeat(MAX_QUEUE_ENVELOPE_BYTES),
    });
    expect(oversized).toMatchObject({ kind: "invalid" });
  });

  it("refuses to encode an invalid envelope", () => {
    expect(() => encodeQueueEnvelopeV1({ ...validEnvelope, entityId: "" })).toThrow();
  });
});
