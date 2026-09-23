import { describe, expect, it } from "vitest";

import {
  projectAuthOperation,
  type AuthOperationProjectionSource,
  type SafePlatformStatus,
} from "../src/index.js";

const active: SafePlatformStatus = {
  platform: "linkedin",
  configured: true,
  source: "credential",
  oauthSupported: true,
  readiness: "ready",
  missingFields: [],
  expiresAt: "2026-09-23T01:00:00.000Z",
  revision: 4,
  target: { label: "alice", source: "provider" },
};

const source: AuthOperationProjectionSource = {
  operationId: "op_0001",
  platform: "linkedin",
  phase: "awaiting_confirmation",
  expiresAt: "2026-09-23T00:30:00.000Z",
  expectedRevision: 4,
  missingFields: ["author"],
  candidateTarget: { label: "bob", source: "provider" },
  receipt: null,
  errorCode: null,
};

describe("auth operation projection", () => {
  it("mirrors the frozen public contract fields", () => {
    const projection = projectAuthOperation({ operation: source, active });
    expect(projection).toEqual({
      platform: "linkedin",
      operationId: "op_0001",
      phase: "awaiting_confirmation",
      expiresAt: "2026-09-23T00:30:00.000Z",
      expectedRevision: 4,
      missingFields: ["author"],
      candidate: { target: { label: "bob", source: "provider" } },
      active,
    });
  });

  it("omits absent optional fields instead of emitting undefined", () => {
    const projection = projectAuthOperation({
      operation: { ...source, candidateTarget: null, phase: "pending_callback", missingFields: [] },
      active,
    });
    expect("candidate" in projection).toBe(false);
    expect("receipt" in projection).toBe(false);
    expect("errorCode" in projection).toBe(false);
  });

  it("keeps active and candidate targets separate", () => {
    const projection = projectAuthOperation({ operation: source, active });
    expect(projection.active.target?.label).toBe("alice");
    expect(projection.candidate?.target?.label).toBe("bob");
  });

  it("passes through only the stored safe receipt", () => {
    const projection = projectAuthOperation({
      operation: {
        ...source,
        phase: "completed",
        receipt: {
          platform: "linkedin",
          operationId: "op_0001",
          stored: true,
          revision: 5,
          configured: true,
          readiness: "ready",
        },
      },
      active: { ...active, revision: 5 },
    });
    expect(projection.receipt).toMatchObject({ revision: 5, stored: true });
  });

  it("freezes its output so callers cannot mutate shared projections", () => {
    const projection = projectAuthOperation({ operation: source, active });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.missingFields)).toBe(true);
  });

  it("projects an expired operation read-only without a candidate", () => {
    const projection = projectAuthOperation({
      operation: source,
      active,
      now: source.expiresAt,
    });
    expect(projection.phase).toBe("expired");
    expect("candidate" in projection).toBe(false);
    // The stored record is untouched: projection is not cleanup.
    expect(source.phase).toBe("awaiting_confirmation");
    expect(source.candidateTarget).toEqual({ label: "bob", source: "provider" });
  });

  it("keeps a completed receipt readable after the TTL while hiding the candidate", () => {
    const projection = projectAuthOperation({
      operation: {
        ...source,
        phase: "completed",
        receipt: {
          platform: "linkedin",
          operationId: "op_0001",
          stored: true,
          revision: 5,
          configured: true,
          readiness: "ready",
        },
      },
      active: { ...active, revision: 5 },
      now: "2027-01-01T00:00:00.000Z",
    });
    expect(projection.phase).toBe("completed");
    expect(projection.receipt).toMatchObject({ revision: 5 });
    expect("candidate" in projection).toBe(false);
  });
});
