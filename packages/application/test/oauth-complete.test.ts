/**
 * Task T6c2a — portable OAuth candidate completion and activation tests.
 *
 * The frozen snapshot fake is wrapped by spies; no real adapter, transport or
 * provider is involved. Every case asserts the outbound step counts, because
 * completion must perform no network work and exactly one activation write.
 */
import { describe, expect, it } from "vitest";

import type { Platform } from "@syndroo/core";

import {
  StoreUnavailable,
  encodeBindingMaterial,
  type AuthOperationStart,
  type CompleteReceiptRecord,
  type CredentialCipher,
  type CredentialStore,
  type EncryptedCredential,
  type PlatformConfigView,
  type PlatformStrategyRegistry,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
  type SafeTarget,
  type StoredAuthOperation,
} from "../src/index.js";
import { AuthUseCaseError } from "../src/use-cases/auth-errors.js";
import { encodeOAuthCandidate } from "../src/use-cases/oauth-candidate.js";
import {
  completeOAuthOperation,
  type CompleteOAuthOperationDependencies,
} from "../src/use-cases/oauth-complete.js";
import { createTestCipher, testEnvelope } from "../src/testing/index.js";
import {
  OAUTH_NOW,
  OAUTH_PLATFORM,
  OAUTH_TTL_END,
  bodyBytes,
  createCipherSpy,
  createClock,
  createDriverSpy,
  createResolverSpy,
  createStoreSpy,
  readOperation,
  seedOperation,
  stubPublisher,
} from "./oauth-test-support.js";

const CALLBACK_URL = "https://worker.example/v1/auth/x/callback";
const CONFIG_BINDING = "config-binding-1";
const CANDIDATE_PLAINTEXT = bodyBytes({ access_token: "candidate-token" });

interface CompleteHarness {
  readonly deps: CompleteOAuthOperationDependencies;
  readonly store: ReturnType<typeof createStoreSpy>;
  readonly driver: ReturnType<typeof createDriverSpy>;
  readonly cipher: ReturnType<typeof createCipherSpy>;
  readonly clock: ReturnType<typeof createClock>;
  readonly strategy: { readonly inputs: PublisherPrepareInput[] };
  readonly bindingIds: () => number;
}

function createHarness(options: { readonly getCipher?: () => CredentialCipher } = {}): CompleteHarness {
  const store = createStoreSpy();
  const driver = createDriverSpy();
  const cipher = createCipherSpy();
  const clock = createClock();
  const inputs: PublisherPrepareInput[] = [];
  const registry: PlatformStrategyRegistry = {
    platforms: [OAUTH_PLATFORM],
    strategyFor: () =>
      ({
        prepare: (input: PublisherPrepareInput): PublisherPreparation => {
          inputs.push(input);
          return {
            kind: "ready",
            prepared: {
              platform: input.platform,
              publisher: stubPublisher(input.platform),
              status: {
                platform: input.platform,
                configured: true,
                source: "credential",
                oauthSupported: true,
                readiness: "ready",
                missingFields: [],
                expiresAt: input.slot.expiresAt,
                revision: input.slot.revision,
              },
              target: null,
              slotBindingId: input.slot.bindingId,
              bindingMaterial: encodeBindingMaterial({
                platform: input.platform,
                source: "credential",
                fields: [["slotBinding", input.slot.bindingId]],
              }),
              credentialRevision: input.slot.revision,
              credentialSource: "credential",
            },
          };
        },
      }) as PublisherStrategy,
  };
  let bindingCalls = 0;
  const deps: CompleteOAuthOperationDependencies = {
    credentials: store.store,
    getCipher: options.getCipher ?? (() => cipher.cipher),
    drivers: createResolverSpy({ [OAUTH_PLATFORM]: driver.driver }).resolver,
    strategies: registry,
    configFor: (platform: Platform): PlatformConfigView => ({
      platform,
      values: {},
      publicUrl: null,
    }),
    clock,
    bindingIds: () => {
      bindingCalls += 1;
      return "bind-complete-1";
    },
  };
  return {
    deps,
    store,
    driver,
    cipher,
    clock,
    strategy: { inputs },
    bindingIds: () => bindingCalls,
  };
}

/** Seed an awaiting-confirmation operation through the real claim/save flow. */
async function seedConfirmable(
  harness: CompleteHarness,
  options: {
    readonly phase?: "awaiting_confirmation" | "needs_configuration";
    readonly missingFields?: readonly string[];
    readonly target?: SafeTarget | null;
    readonly expiresAt?: string | null;
    readonly operation?: Partial<AuthOperationStart>;
    readonly cipher?: CredentialCipher;
  } = {},
): Promise<void> {
  const cipher = options.cipher ?? createTestCipher();
  await seedOperation(harness.store, {
    requestToken: null,
    startConfigBinding: CONFIG_BINDING,
    canonicalCallbackUrl: CALLBACK_URL,
    ...options.operation,
  });
  await harness.store.store.claimOAuthCallback({
    platform: OAUTH_PLATFORM,
    oauthState: "state-1",
    requestToken: null,
    now: OAUTH_NOW,
    currentConfigBinding: CONFIG_BINDING,
  });
  const encoded = encodeOAuthCandidate({
    plaintext: CANDIDATE_PLAINTEXT,
    expiresAt: options.expiresAt ?? null,
  });
  expect(encoded.kind).toBe("ok");
  if (encoded.kind !== "ok") {
    return;
  }
  const envelope = await cipher.encrypt(encoded.bytes, {
    purpose: "oauth_candidate",
    recordId: "op-1",
    platform: OAUTH_PLATFORM,
    payloadSchemaVersion: 1,
    payloadRevision: 1,
  });
  await harness.store.store.saveCandidate({
    operationId: "op-1",
    platform: OAUTH_PLATFORM,
    now: OAUTH_NOW,
    outcome: {
      kind: "candidate",
      phase: options.phase ?? "awaiting_confirmation",
      candidateEnvelope: envelope,
      candidatePayloadRevision: 1,
      candidatePayloadSchemaVersion: 1,
      candidateTarget: options.target === undefined ? null : options.target,
      missingFields: options.missingFields ?? [],
    },
  });
}

function completeInput(
  overrides: Partial<Parameters<typeof completeOAuthOperation>[0]> = {},
): Parameters<typeof completeOAuthOperation>[0] {
  return {
    platform: OAUTH_PLATFORM,
    operationId: "op-1",
    expectedRevision: 0,
    ...overrides,
  };
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

function storedOperation(overrides: Partial<StoredAuthOperation> = {}): StoredAuthOperation {
  return {
    operationId: "op-1",
    platform: OAUTH_PLATFORM,
    phase: "awaiting_confirmation",
    expectedRevision: 0,
    canonicalCallbackUrl: CALLBACK_URL,
    startConfigBinding: CONFIG_BINDING,
    oauthState: "state-1",
    requestToken: null,
    requestSecret: null,
    requestSecretPurpose: null,
    requestSecretRevision: null,
    candidateEnvelope: testEnvelope("candidate"),
    candidatePayloadRevision: 1,
    candidatePayloadSchemaVersion: 1,
    candidateTarget: null,
    receipt: null,
    missingFields: [],
    errorCode: null,
    createdAt: OAUTH_NOW,
    updatedAt: OAUTH_NOW,
    expiresAt: OAUTH_TTL_END,
    ...overrides,
  };
}

describe("completeOAuthOperation — activation", () => {
  it("activates the candidate with no network work and one atomic write", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("completion must not perform network work");
    }) as typeof fetch;
    let receipt: CompleteReceiptRecord;
    try {
      receipt = await completeOAuthOperation(
        completeInput({
          target: { author: "urn:li:person:author", apiVersion: "202604", blog: null },
        }),
        harness.deps,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(harness.driver.begins).toEqual([]);
    expect(harness.driver.exchanges).toEqual([]);
    expect(harness.store.counts.compareAndSetSlot).toBe(0);
    expect(harness.store.counts.activateCandidate).toBe(1);
    expect(receipt).toEqual({
      platform: OAUTH_PLATFORM,
      operationId: "op-1",
      stored: true,
      revision: 1,
      configured: true,
      readiness: "ready",
    });
    expect(Object.isFrozen(receipt)).toBe(true);

    // Candidate AAD and active AAD use their own identities.
    expect(harness.cipher.decryptContexts).toEqual([
      {
        purpose: "oauth_candidate",
        recordId: "op-1",
        platform: OAUTH_PLATFORM,
        payloadSchemaVersion: 1,
        payloadRevision: 1,
      },
    ]);
    expect(harness.cipher.encryptContexts).toEqual([
      {
        purpose: "active_slot",
        recordId: OAUTH_PLATFORM,
        platform: OAUTH_PLATFORM,
        payloadSchemaVersion: 1,
        payloadRevision: 1,
      },
    ]);
    expect(harness.driver.confirms).toHaveLength(1);
    expect(harness.driver.confirms[0]?.target).toEqual({
      author: "urn:li:person:author",
      apiVersion: "202604",
      blog: null,
    });
    expect(harness.driver.confirms[0]?.now).toBe(OAUTH_NOW);

    // The slot holds exactly the proposed connection.
    const slot = await harness.store.store.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot).toMatchObject({
      platform: OAUTH_PLATFORM,
      status: "active",
      revision: 1,
      bindingId: "bind-complete-1",
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: null,
      refreshLease: null,
      refreshState: "ready",
    });
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.phase).toBe("completed");
    expect(stored?.candidateEnvelope).toBeNull();
    expect(stored?.receipt).toEqual(receipt);
  });

  it("returns the stored receipt with replayed=true before any other check", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    const first = await completeOAuthOperation(completeInput(), harness.deps);
    const bindingCallsAfterFirst = harness.bindingIds();

    // A stale revision, a broken resolver and a throwing cipher: none of them may
    // stop the replay, and none may be consulted.
    const broken: CompleteOAuthOperationDependencies = {
      ...harness.deps,
      drivers: () => {
        throw new Error("SENTINEL_REPLAY_RESOLVER");
      },
      getCipher: () => {
        throw new Error("SENTINEL_REPLAY_CIPHER");
      },
    };
    const replay = await completeOAuthOperation(
      completeInput({ expectedRevision: 7 }),
      broken,
    );

    expect(replay).toEqual({ ...first, replayed: true });
    expect(harness.bindingIds()).toBe(bindingCallsAfterFirst);
    expect(harness.store.counts.activateCandidate).toBe(1);
    expect(harness.store.counts.readSlot).toBe(1);
  });

  it("reports a completed operation without a stored receipt as corrupt", async () => {
    const harness = createHarness();
    harness.store.returnNextOperation(
      storedOperation({ phase: "completed", receipt: null }),
    );

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("corrupt_record");
    expect(harness.store.counts.activateCandidate).toBe(0);
  });

  it("rejects a malformed stored receipt instead of coercing it", async () => {
    const cases: readonly Partial<StoredAuthOperation>[] = [
      { receipt: { ...completedReceipt(), stored: false } as never },
      { receipt: { ...completedReceipt(), configured: "yes" } as never },
      { receipt: { ...completedReceipt(), readiness: "unknown-state" } as never },
      { receipt: { ...completedReceipt(), revision: -1 } as never },
      { receipt: { ...completedReceipt(), operationId: "other-operation" } as never },
      { receipt: { ...completedReceipt(), platform: "threads" } as never },
    ];
    for (const overrides of cases) {
      const harness = createHarness();
      harness.store.returnNextOperation(storedOperation({ phase: "completed", ...overrides }));

      const failure = await expectAuthFailure(
        completeOAuthOperation(completeInput(), harness.deps),
      );

      expect(failure.code, JSON.stringify(overrides)).toBe("STORE_UNAVAILABLE");
      expect(failure.reason, JSON.stringify(overrides)).toBe("corrupt_record");
      expect(harness.store.counts.activateCandidate).toBe(0);
    }
  });
});

function completedReceipt(): CompleteReceiptRecord {
  return {
    platform: OAUTH_PLATFORM,
    operationId: "op-1",
    stored: true,
    revision: 1,
    configured: true,
    readiness: "ready",
  };
}

describe("completeOAuthOperation — guards and identity", () => {
  it("cannot revive an older operation with a stale revision", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput({ expectedRevision: 5 }), harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.cipher.encryptContexts).toEqual([]);
    expect(harness.driver.confirms).toEqual([]);
    expect(harness.store.counts.activateCandidate).toBe(0);
    const slot = await harness.store.store.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot.status).toBe("empty");
  });

  it("requires the caller revision to match the slot as well as the operation", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    // A different connection appears before completion.
    await harness.store.fake.credentials.compareAndSetSlot({
      platform: OAUTH_PLATFORM,
      expectedRevision: 0,
      now: OAUTH_NOW,
      change: {
        kind: "set",
        bindingId: "bind-other",
        envelope: testEnvelope("other"),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput({ expectedRevision: 1 }), harness.deps),
    );

    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.store.counts.activateCandidate).toBe(0);
  });

  it("keeps a foreign or mismatched operation opaque", async () => {
    const foreign = createHarness();
    foreign.store.returnNextOperation(storedOperation({ platform: "threads" }));
    const foreignFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), foreign.deps),
    );
    expect(foreignFailure.code).toBe("NOT_FOUND");
    expect(foreignFailure.reason).toBe("operation_not_found");

    const mismatched = createHarness();
    mismatched.store.returnNextOperation(storedOperation({ operationId: "other-id" }));
    const mismatchFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), mismatched.deps),
    );
    expect(mismatchFailure.code).toBe("STORE_UNAVAILABLE");
    expect(mismatchFailure.reason).toBe("corrupt_record");

    const missing = createHarness();
    const missingFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput({ operationId: "absent-op" }), missing.deps),
    );
    expect(missingFailure.code).toBe("NOT_FOUND");
  });

  it("rejects a missing, corrupt or expired candidate before activation", async () => {
    const missingCandidate = createHarness();
    missingCandidate.store.returnNextOperation(
      storedOperation({ candidateEnvelope: null, candidatePayloadRevision: null }),
    );
    const missing = await expectAuthFailure(
      completeOAuthOperation(completeInput(), missingCandidate.deps),
    );
    expect(missing.reason).toBe("corrupt_record");
    expect(missingCandidate.store.counts.activateCandidate).toBe(0);

    const wrongVersion = createHarness();
    wrongVersion.store.returnNextOperation(
      storedOperation({ candidatePayloadSchemaVersion: 2 }),
    );
    const version = await expectAuthFailure(
      completeOAuthOperation(completeInput(), wrongVersion.deps),
    );
    expect(version.reason).toBe("corrupt_record");

    const wrongKey = createHarness();
    await seedConfirmable(wrongKey, { cipher: createTestCipher("other-key") });
    const key = await expectAuthFailure(
      completeOAuthOperation(completeInput(), wrongKey.deps),
    );
    expect(key.code).toBe("INSTANCE_NOT_READY");
    expect(key.reason).toBe("cipher_unavailable");

    const undecodable = createHarness();
    await seedConfirmable(undecodable);
    // Replace the stored ciphertext with a valid envelope of garbage bytes.
    const garbage = await createTestCipher().encrypt(new Uint8Array([1, 2, 3]), {
      purpose: "oauth_candidate",
      recordId: "op-1",
      platform: OAUTH_PLATFORM,
      payloadSchemaVersion: 1,
      payloadRevision: 1,
    });
    undecodable.store.returnNextOperation(
      storedOperation({ candidateEnvelope: garbage }),
    );
    const corrupt = await expectAuthFailure(
      completeOAuthOperation(completeInput(), undecodable.deps),
    );
    expect(corrupt.code).toBe("STORE_UNAVAILABLE");
    expect(corrupt.reason).toBe("candidate_invalid");

    const expiredOperation = createHarness();
    expiredOperation.store.returnNextOperation(
      storedOperation({ expiresAt: "2026-09-22T23:00:00.000Z" }),
    );
    const operation = await expectAuthFailure(
      completeOAuthOperation(completeInput(), expiredOperation.deps),
    );
    expect(operation.reason).toBe("operation_expired");

    const expiredCandidate = createHarness();
    await seedConfirmable(expiredCandidate, { expiresAt: "2026-09-22T23:00:00.000Z" });
    const candidate = await expectAuthFailure(
      completeOAuthOperation(completeInput(), expiredCandidate.deps),
    );
    expect(candidate.reason).toBe("candidate_expired");
    expect(expiredCandidate.store.counts.activateCandidate).toBe(0);
  });

  it("never inherits an old active target and reports what is still missing", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    // A synthetic slot that carries an old target makes inheritance observable.
    harness.store.returnNextSlot({
      ...(await harness.store.store.readSlot({ platform: OAUTH_PLATFORM })),
      status: "active",
      bindingId: "bind-old",
      envelope: testEnvelope("old"),
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      target: { label: "old-active-target", source: "provider" },
      revision: 0,
    });
    harness.driver.setConfirmResult({
      plaintext: bodyBytes({ access_token: "confirmed" }),
      target: null,
      missingFields: ["author"],
    });

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("target_required");
    expect(harness.driver.confirms[0]?.target).toEqual({
      author: null,
      apiVersion: null,
      blog: null,
    });
    expect(harness.store.counts.activateCandidate).toBe(0);
    expect(harness.cipher.encryptContexts).toEqual([]);
  });

  it("refuses a changed driver configuration", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    const otherDriver = createDriverSpy({ startConfigBinding: "config-binding-2" });

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), {
        ...harness.deps,
        drivers: createResolverSpy({ [OAUTH_PLATFORM]: otherDriver.driver }).resolver,
      }),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("config_changed");
    expect(harness.store.counts.activateCandidate).toBe(0);
  });

  it("checks the generation bound before encrypting", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    const current = await harness.store.store.readSlot({ platform: OAUTH_PLATFORM });
    harness.store.returnNextSlot({
      ...current,
      status: "active",
      payloadRevision: Number.MAX_SAFE_INTEGER,
    });

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), harness.deps),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("payload_generation_overflow");
    expect(harness.cipher.encryptContexts).toEqual([]);
    expect(harness.store.counts.activateCandidate).toBe(0);
  });
});

describe("completeOAuthOperation — concurrency and atomicity", () => {
  it("activates once when two completions race", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);

    const results = await Promise.allSettled([
      completeOAuthOperation(completeInput(), harness.deps),
      completeOAuthOperation(completeInput(), harness.deps),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(harness.store.counts.activateCandidate).toBe(2);
    const receipts = results.map((result) =>
      result.status === "fulfilled" ? result.value : null,
    );
    const fresh = receipts.filter((receipt) => receipt !== null && receipt.replayed !== true);
    const replayed = receipts.filter((receipt) => receipt?.replayed === true);
    expect(fresh).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toEqual({ ...(fresh[0] as CompleteReceiptRecord), replayed: true });
    const slot = await harness.store.store.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot.revision).toBe(1);
  });

  it("loses the CAS cleanly when a direct set or remove wins", async () => {
    for (const kind of ["set", "remove"] as const) {
      const harness = createHarness();
      await seedConfirmable(harness);
      harness.store.beforeActivate(async () => {
        await harness.store.fake.credentials.compareAndSetSlot({
          platform: OAUTH_PLATFORM,
          expectedRevision: 0,
          now: OAUTH_NOW,
          change:
            kind === "remove"
              ? { kind: "remove" }
              : {
                  kind: "set",
                  bindingId: "bind-winner",
                  envelope: testEnvelope("winner"),
                  payloadRevision: 1,
                  payloadSchemaVersion: 1,
                  expiresAt: null,
                  target: null,
                },
        });
      });

      const failure = await expectAuthFailure(
        completeOAuthOperation(completeInput(), harness.deps),
      );

      expect(failure.code, kind).toBe("AUTH_CONFLICT");
      expect(failure.reason, kind).toBe("revision_mismatch");
      expect(harness.store.counts.activateCandidate, kind).toBe(1);
      const slot = await harness.store.store.readSlot({ platform: OAUTH_PLATFORM });
      expect(slot.status, kind).toBe(kind === "remove" ? "tombstone" : "active");
      expect(slot.revision, kind).toBe(1);
      if (kind === "set") {
        expect(slot.bindingId).toBe("bind-winner");
      }
    }
  });

  it("recovers a lost activation acknowledgement through an explicit replay", async () => {
    const harness = createHarness();
    await seedConfirmable(harness);
    harness.store.commitActivationThenThrow();

    const failure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_LOST_ACTIVATION_ACK");
    expect(harness.cipher.encryptContexts).toHaveLength(1);
    expect(harness.bindingIds()).toBe(1);
    const committed = await harness.store.store.readSlot({ platform: OAUTH_PLATFORM });
    expect(committed.status).toBe("active");

    const replay = await completeOAuthOperation(completeInput(), harness.deps);

    expect(replay).toEqual({ ...completedReceipt(), replayed: true });
    expect(harness.cipher.encryptContexts).toHaveLength(1);
    expect(harness.bindingIds()).toBe(1);
    // The explicit replay leaves the completed operation alone: no second
    // activation call, no new encryption and no new binding.
    expect(harness.store.counts.activateCandidate).toBe(1);
  });

  it("validates the activation result kind and revision", async () => {
    const cases: readonly unknown[] = [
      { kind: "activated", revision: 99, receipt: completedReceipt() },
      { kind: "replayed", revision: 41, receipt: { ...completedReceipt(), replayed: true } },
      { kind: "something-else", revision: 1, receipt: completedReceipt() },
    ];
    for (const result of cases) {
      const harness = createHarness();
      await seedConfirmable(harness);
      const broken: CredentialStore = {
        ...harness.store.store,
        async activateCandidate() {
          return result as never;
        },
      };

      const failure = await expectAuthFailure(
        completeOAuthOperation(completeInput(), { ...harness.deps, credentials: broken }),
      );

      expect(
        `${String((result as { kind?: unknown }).kind)}:${failure.code}:${failure.reason}`,
      ).toBe(
        (result as { kind?: unknown }).kind === "something-else"
          ? "something-else:STORE_UNAVAILABLE:unexpected_result"
          : `${String((result as { kind?: unknown }).kind)}:STORE_UNAVAILABLE:corrupt_record`,
      );
    }
  });
});

describe("completeOAuthOperation — input safety", () => {
  it("rejects malformed input and targets before reading storage", async () => {
    const invalidInputs: readonly (readonly [unknown, string])[] = [
      [null, "INVALID_REQUEST"],
      [{}, "INVALID_REQUEST"],
      [{ platform: "not-a-platform", operationId: "op-1", expectedRevision: 0 }, "INVALID_REQUEST"],
      // A malformed identifier never confirms whether an operation exists.
      [{ platform: OAUTH_PLATFORM, operationId: "not opaque!", expectedRevision: 0 }, "NOT_FOUND"],
      [{ platform: OAUTH_PLATFORM, operationId: "op-1", expectedRevision: -1 }, "INVALID_REQUEST"],
      [{ platform: OAUTH_PLATFORM, operationId: "op-1", expectedRevision: 1.5 }, "INVALID_REQUEST"],
      [
        {
          platform: OAUTH_PLATFORM,
          operationId: "op-1",
          expectedRevision: 0,
          target: { unknown: "value" },
        },
        "INVALID_REQUEST",
      ],
      [
        {
          platform: OAUTH_PLATFORM,
          operationId: "op-1",
          expectedRevision: 0,
          target: { author: " author-with-space" },
        },
        "INVALID_REQUEST",
      ],
      [
        {
          platform: OAUTH_PLATFORM,
          operationId: "op-1",
          expectedRevision: 0,
          target: { blog: "bad\u0000blog" },
        },
        "INVALID_REQUEST",
      ],
    ];
    for (const [input, expectedCode] of invalidInputs) {
      const harness = createHarness();
      const failure = await expectAuthFailure(
        completeOAuthOperation(
          input as Parameters<typeof completeOAuthOperation>[0],
          harness.deps,
        ),
      );
      expect(failure.code, JSON.stringify(input)).toBe(expectedCode);
      expect(harness.store.counts.readAuthOperation, JSON.stringify(input)).toBe(0);
      expect(harness.store.counts.activateCandidate, JSON.stringify(input)).toBe(0);
    }
  });

  it("never lets hostile input, a forged failure or a thenable confirm escape", async () => {
    const hostile = createHarness();
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "platform", {
      enumerable: true,
      get() {
        throw new Error("SENTINEL_COMPLETE_GETTER");
      },
    });
    const getterFailure = await expectAuthFailure(
      completeOAuthOperation(
        input as unknown as Parameters<typeof completeOAuthOperation>[0],
        hostile.deps,
      ),
    );
    expect(getterFailure.code).toBe("INVALID_REQUEST");
    expect(getterFailure.message).not.toContain("SENTINEL_COMPLETE_GETTER");

    const forged = createHarness();
    await seedConfirmable(forged);
    const forgedError = Object.create(AuthUseCaseError.prototype) as AuthUseCaseError;
    Object.defineProperty(forgedError, "code", {
      get() {
        throw new Error("SENTINEL_FORGED_COMPLETE_CODE");
      },
    });
    Object.defineProperty(forgedError, "reason", {
      get() {
        throw new Error("SENTINEL_FORGED_COMPLETE_REASON");
      },
    });
    forged.driver.failNextConfirm(forgedError);
    const forgedFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), forged.deps),
    );
    expect(forgedFailure.code).toBe("INVALID_REQUEST");
    expect(forgedFailure.reason).toBe("target");
    expect(forgedFailure.message).not.toContain("SENTINEL_FORGED_COMPLETE");

    // A driver that returns a rejected promise must not produce an unhandled
    // rejection: the contract violation is fixed and the rejection disposed.
    const thenable = createHarness();
    await seedConfirmable(thenable);
    thenable.driver.setConfirmRawResult(Promise.reject(new Error("SENTINEL_THENABLE")));
    const thenableFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), thenable.deps),
    );
    expect(thenableFailure.code).toBe("INSTANCE_NOT_READY");
    expect(thenableFailure.reason).toBe("invalid_driver_response");
    expect(thenable.store.counts.activateCandidate).toBe(0);

    const malformedConfirm = createHarness();
    await seedConfirmable(malformedConfirm);
    malformedConfirm.driver.setConfirmRawResult({ plaintext: "not-bytes", missingFields: [] });
    const malformedFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), malformedConfirm.deps),
    );
    expect(malformedFailure.reason).toBe("invalid_driver_response");

    const badFields = createHarness();
    await seedConfirmable(badFields);
    badFields.driver.setConfirmResult({
      plaintext: bodyBytes({ access_token: "confirmed" }),
      target: null,
      missingFields: ["SECRET_UPPERCASE_TOKEN"],
    });
    const fieldsFailure = await expectAuthFailure(
      completeOAuthOperation(completeInput(), badFields.deps),
    );
    expect(fieldsFailure.reason).toBe("invalid_driver_response");
  });
});
