/**
 * Task T6c1 — read-only authorization operation projection tests.
 *
 * Polling must stay free: no claim, no candidate write, no slot mutation, no TTL
 * renewal and no provider request. These tests assert the call counts directly.
 */
import { describe, expect, it } from "vitest";

import { StoreUnavailable, type StoredAuthOperation } from "../src/index.js";
import { AuthUseCaseError } from "../src/use-cases/auth-errors.js";
import {
  readAuthOperationProjection,
  type AuthOperationReadInput,
} from "../src/use-cases/auth-operation.js";
import {
  OAUTH_NOW,
  OAUTH_PLATFORM,
  OAUTH_TTL_END,
  createClock,
  createPrepareStub,
  createStoreSpy,
  readOperation,
  seedOperation,
} from "./oauth-test-support.js";

const CALLBACK_URL = "https://worker.example/v1/auth/x/callback";

interface OperationHarness {
  readonly store: ReturnType<typeof createStoreSpy>;
  readonly prepare: ReturnType<typeof createPrepareStub>;
  readonly clock: ReturnType<typeof createClock>;
}

function createHarness(): OperationHarness {
  return { store: createStoreSpy(), prepare: createPrepareStub(), clock: createClock() };
}

function read(harness: OperationHarness, operationId = "op-1", platform = OAUTH_PLATFORM) {
  return readAuthOperationProjection(
    { platform, operationId },
    {
      credentials: harness.store.store,
      prepare: harness.prepare.prepare,
      clock: harness.clock,
    },
  );
}

async function expectAuthFailure(promise: Promise<unknown>): Promise<AuthUseCaseError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthUseCaseError);
    return error as AuthUseCaseError;
  }
  throw new Error("expected an AuthUseCaseError");
}

function completedOperation(): StoredAuthOperation {
  return {
    operationId: "op-1",
    platform: OAUTH_PLATFORM,
    phase: "completed",
    expectedRevision: 0,
    canonicalCallbackUrl: CALLBACK_URL,
    startConfigBinding: "config-binding-1",
    oauthState: "state-1",
    requestToken: null,
    requestSecret: null,
    requestSecretPurpose: null,
    requestSecretRevision: null,
    candidateEnvelope: null,
    candidatePayloadRevision: null,
    candidatePayloadSchemaVersion: null,
    candidateTarget: null,
    receipt: {
      platform: OAUTH_PLATFORM,
      operationId: "op-1",
      stored: true,
      revision: 1,
      configured: true,
      readiness: "ready",
    },
    missingFields: [],
    errorCode: null,
    createdAt: OAUTH_NOW,
    updatedAt: OAUTH_NOW,
    expiresAt: OAUTH_TTL_END,
  };
}

describe("readAuthOperationProjection", () => {
  it("projects a pending operation with the current active status", async () => {
    const harness = createHarness();
    await seedOperation(harness.store);

    const projection = await read(harness);

    expect(projection).toMatchObject({
      platform: OAUTH_PLATFORM,
      operationId: "op-1",
      phase: "pending_callback",
      expiresAt: OAUTH_TTL_END,
      expectedRevision: 0,
    });
    expect(projection.active.configured).toBe(true);
    expect(projection.active.readiness).toBe("ready");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(harness.store.counts.readAuthOperation).toBe(1);
    expect(harness.prepare.calls).toEqual([{ platform: OAUTH_PLATFORM, now: OAUTH_NOW }]);
    // Reading is free: nothing is claimed, saved, activated or written.
    expect(harness.store.counts.claimOAuthCallback).toBe(0);
    expect(harness.store.counts.saveCandidate).toBe(0);
    expect(harness.store.counts.activateCandidate).toBe(0);
    expect(harness.store.counts.compareAndSetSlot).toBe(0);
    expect(harness.store.mutations).toEqual([]);
  });

  it("projects an expired operation without renewing or writing", async () => {
    const harness = createHarness();
    await seedOperation(harness.store, { expiresAt: "2026-09-22T23:00:00.000Z" });

    const projection = await read(harness);

    expect(projection.phase).toBe("expired");
    expect(projection.expiresAt).toBe("2026-09-22T23:00:00.000Z");
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.expiresAt).toBe("2026-09-22T23:00:00.000Z");
    expect(harness.store.counts.saveCandidate).toBe(0);
    expect(harness.store.counts.claimOAuthCallback).toBe(0);
  });

  it("replays a completed receipt even when the active status is blocked", async () => {
    const harness = createHarness();
    harness.store.returnNextOperation(completedOperation());
    harness.prepare.setBlocked("missing_credentials");

    const projection = await read(harness);

    expect(projection.phase).toBe("completed");
    expect(projection.receipt).toMatchObject({ revision: 1, readiness: "ready" });
    expect(projection.active.readiness).toBe("missing_credentials");
    expect(harness.store.counts.saveCandidate).toBe(0);
    expect(harness.store.counts.activateCandidate).toBe(0);
  });

  it("stays unchanged across repeated polls", async () => {
    const harness = createHarness();
    await seedOperation(harness.store);

    const first = await read(harness);
    harness.clock.set("2026-09-23T00:10:00.000Z");
    const second = await read(harness);

    expect(second.phase).toBe("pending_callback");
    expect(second.expiresAt).toBe(first.expiresAt);
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.expiresAt).toBe(OAUTH_TTL_END);
    expect(harness.store.counts.compareAndSetSlot).toBe(0);
  });

  it("keeps an unknown or foreign operation indistinguishable", async () => {
    const missing = createHarness();
    const missingFailure = await expectAuthFailure(read(missing));
    expect(missingFailure.code).toBe("NOT_FOUND");
    expect(missingFailure.reason).toBe("operation_not_found");
    expect(missing.prepare.calls).toEqual([]);

    const foreign = createHarness();
    await seedOperation(foreign.store);
    const foreignFailure = await expectAuthFailure(read(foreign, "op-1", "threads"));
    expect(foreignFailure.code).toBe("NOT_FOUND");
    expect(foreign.prepare.calls).toEqual([]);

    const malformed = createHarness();
    const malformedFailure = await expectAuthFailure(read(malformed, "not opaque!"));
    expect(malformedFailure.code).toBe("NOT_FOUND");
    expect(malformed.store.counts.readAuthOperation).toBe(0);

    const badPlatform = createHarness();
    const platformFailure = await expectAuthFailure(
      readAuthOperationProjection(
        { platform: "not-a-platform" as never, operationId: "op-1" },
        { credentials: badPlatform.store.store, prepare: badPlatform.prepare.prepare, clock: badPlatform.clock },
      ),
    );
    expect(platformFailure.code).toBe("INVALID_REQUEST");
    expect(badPlatform.store.counts.readAuthOperation).toBe(0);
  });

  it("keeps storage and preparation failures fixed and text-free", async () => {
    const readFailure = createHarness();
    readFailure.store.failNextRead(new StoreUnavailable("SENTINEL_OPERATION_READ"));
    const failed = await expectAuthFailure(read(readFailure));
    expect(failed.code).toBe("STORE_UNAVAILABLE");
    expect(failed.reason).toBe("store_unavailable");
    expect(failed.message).not.toContain("SENTINEL_OPERATION_READ");
    expect(readFailure.prepare.calls).toEqual([]);

    const prepareFailure = createHarness();
    await seedOperation(prepareFailure.store);
    prepareFailure.prepare.failNext(
      new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable"),
    );
    const preserved = await expectAuthFailure(read(prepareFailure));
    expect(preserved.code).toBe("INSTANCE_NOT_READY");
    expect(preserved.reason).toBe("cipher_unavailable");

    const hostilePrepare = createHarness();
    await seedOperation(hostilePrepare.store);
    hostilePrepare.prepare.failNext(new Error("SENTINEL_PREPARE_TEXT"));
    const other = await expectAuthFailure(read(hostilePrepare));
    expect(other.code).toBe("STORE_UNAVAILABLE");
    expect(other.reason).toBe("unavailable");
    expect(other.message).not.toContain("SENTINEL_PREPARE_TEXT");
  });

  it("never reads a hostile input getter or a forged auth failure", async () => {
    const harness = createHarness();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "platform", {
      enumerable: true,
      get() {
        throw new Error("SENTINEL_OPERATION_GETTER");
      },
    });

    const getterFailure = await expectAuthFailure(
      readAuthOperationProjection(hostile as unknown as AuthOperationReadInput, {
        credentials: harness.store.store,
        prepare: harness.prepare.prepare,
        clock: harness.clock,
      }),
    );
    expect(getterFailure.code).toBe("INVALID_REQUEST");
    expect(getterFailure.message).not.toContain("SENTINEL_OPERATION_GETTER");
    expect(harness.store.counts.readAuthOperation).toBe(0);

    const forgedHarness = createHarness();
    await seedOperation(forgedHarness.store);
    const forged = Object.create(AuthUseCaseError.prototype) as AuthUseCaseError;
    Object.defineProperty(forged, "code", {
      get() {
        throw new Error("SENTINEL_FORGED_OPERATION_CODE");
      },
    });
    Object.defineProperty(forged, "reason", {
      get() {
        throw new Error("SENTINEL_FORGED_OPERATION_REASON");
      },
    });
    forgedHarness.prepare.failNext(forged);

    const forgedFailure = await expectAuthFailure(read(forgedHarness));
    expect(forgedFailure.code).toBe("STORE_UNAVAILABLE");
    expect(forgedFailure.reason).toBe("unavailable");
    expect(forgedFailure.message).not.toContain("SENTINEL_FORGED_OPERATION");
  });
});
