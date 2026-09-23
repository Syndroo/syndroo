/**
 * Task T6c2b — portable OAuth credential refresh tests.
 *
 * The frozen snapshot fake is wrapped by spies. Every case asserts the lease and
 * exchange counts, because refresh must never reach the provider before the
 * preflight, the lease and the exact acquired snapshot have all been validated.
 */
import { describe, expect, it } from "vitest";

import type { Platform } from "@syndroo/core";

import {
  StoreUnavailable,
  encodeBindingMaterial,
  type CredentialCipher,
  type CredentialStore,
  type EncryptedSlotSnapshot,
  type IsoInstant,
  type PlatformConfigView,
  type PlatformStrategyRegistry,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
  type SafeTarget,
} from "../src/index.js";
import { AuthUseCaseError } from "../src/use-cases/auth-errors.js";
import { OAuthDriverError } from "../src/use-cases/oauth-driver.js";
import {
  refreshOAuthCredential,
  type RefreshOAuthCredentialDependencies,
} from "../src/use-cases/oauth-refresh.js";
import type {
  OAuthRefreshDriver,
  OAuthRefreshDriverResolver,
} from "../src/use-cases/oauth-refresh-driver.js";
import { createTestCipher, testEnvelope } from "../src/testing/index.js";
import {
  OAUTH_NOW,
  OAUTH_PLATFORM,
  bodyBytes,
  createCipherSpy,
  createClock,
  createRefreshDriverSpy,
  createRefreshResolverSpy,
  createStoreSpy,
  stubPublisher,
} from "./oauth-test-support.js";

const LEASE_START = OAUTH_NOW;
const LEASE_END = "2026-09-23T00:01:00.000Z";
const LATE = "2026-09-23T00:02:00.000Z";
const NEW_EXPIRY = "2026-12-31T23:59:59.000Z";
const NATIVE_PAYLOAD = bodyBytes({ access_token: "old-token", refresh_token: "old-refresh" });
const EXISTING_TARGET: SafeTarget = { label: "existing-target", source: "user" };

interface RefreshHarness {
  readonly deps: RefreshOAuthCredentialDependencies;
  readonly store: ReturnType<typeof createStoreSpy>;
  readonly driver: ReturnType<typeof createRefreshDriverSpy>;
  readonly resolver: ReturnType<typeof createRefreshResolverSpy>;
  readonly cipher: ReturnType<typeof createCipherSpy>;
  readonly clock: ReturnType<typeof createClock>;
  readonly leaseTokenCalls: () => number;
}

function createHarness(
  options: { readonly getCipher?: () => CredentialCipher; readonly drivers?: ReturnType<typeof createRefreshResolverSpy> } = {},
): RefreshHarness {
  const store = createStoreSpy();
  const driver = createRefreshDriverSpy();
  const resolver = options.drivers ?? createRefreshResolverSpy({ [OAUTH_PLATFORM]: driver.driver });
  const cipher = createCipherSpy();
  const clock = createClock();
  let leaseTokenCalls = 0;
  const registry: PlatformStrategyRegistry = {
    platforms: [OAUTH_PLATFORM],
    strategyFor: () =>
      ({
        prepare: (input: PublisherPrepareInput): PublisherPreparation => ({
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
        }),
      }) as PublisherStrategy,
  };
  const deps: RefreshOAuthCredentialDependencies = {
    credentials: store.store,
    getCipher: options.getCipher ?? (() => cipher.cipher),
    drivers: resolver.resolver,
    strategies: registry,
    configFor: (platform: Platform): PlatformConfigView => ({
      platform,
      values: {},
      publicUrl: null,
    }),
    clock,
    leaseTokens: () => {
      leaseTokenCalls += 1;
      return "lease-token-1";
    },
  };
  return {
    deps,
    store,
    driver,
    resolver,
    cipher,
    clock,
    leaseTokenCalls: () => leaseTokenCalls,
  };
}

/** Seed an active slot through the frozen store surface. */
async function seedActive(
  harness: RefreshHarness,
  options: {
    readonly payloadRevision?: number;
    readonly target?: SafeTarget | null;
    readonly expiresAt?: IsoInstant | null;
    readonly payload?: Uint8Array;
    readonly cipher?: CredentialCipher;
  } = {},
): Promise<void> {
  const payloadRevision = options.payloadRevision ?? 1;
  const cipher = options.cipher ?? createTestCipher();
  const envelope = await cipher.encrypt(options.payload ?? NATIVE_PAYLOAD, {
    purpose: "active_slot",
    recordId: OAUTH_PLATFORM,
    platform: OAUTH_PLATFORM,
    payloadSchemaVersion: 1,
    payloadRevision,
  });
  const result = await harness.store.fake.credentials.compareAndSetSlot({
    platform: OAUTH_PLATFORM,
    expectedRevision: 0,
    now: LEASE_START,
    change: {
      kind: "set",
      bindingId: "bind-existing",
      envelope,
      payloadRevision,
      payloadSchemaVersion: 1,
      expiresAt: options.expiresAt ?? null,
      target: options.target === undefined ? EXISTING_TARGET : options.target,
    },
  });
  expect(result.kind).toBe("applied");
}

/** Seed the active slot only when the platform has none yet. */
async function seedSlotIfEmpty(harness: RefreshHarness): Promise<void> {
  const slot = await harness.store.fake.credentials.readSlot({ platform: OAUTH_PLATFORM });
  if (slot.status === "empty") {
    await seedActive(harness);
  }
}

/** Give the slot a live lease as if another holder had acquired it. */
async function seedLiveLease(harness: RefreshHarness): Promise<void> {
  await seedSlotIfEmpty(harness);
  const result = await harness.store.fake.credentials.acquireRefresh({
    platform: OAUTH_PLATFORM,
    expectedRevision: 1,
    leaseToken: "held-lease",
    now: LEASE_START,
    leaseDurationMs: 60_000,
  });
  expect(result.kind).toBe("acquired");
}

async function seedReconnectRequired(harness: RefreshHarness): Promise<void> {
  await seedLiveLease(harness);
  const result = await harness.store.fake.credentials.markReconnectRequired({
    platform: OAUTH_PLATFORM,
    leaseToken: "held-lease",
    expectedRevision: 1,
    now: LEASE_START,
    reason: "provider_rejected",
  });
  expect(result.kind).toBe("applied");
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

function slotSnapshot(overrides: Partial<EncryptedSlotSnapshot> = {}): EncryptedSlotSnapshot {
  return {
    platform: OAUTH_PLATFORM,
    status: "active",
    revision: 1,
    bindingId: "bind-existing",
    envelope: null,
    payloadRevision: 1,
    payloadSchemaVersion: 1,
    expiresAt: null,
    target: EXISTING_TARGET,
    refreshLease: null,
    refreshState: "ready",
    lastRefreshCommitFingerprint: null,
    updatedAt: LEASE_START,
    ...overrides,
  };
}

describe("refreshOAuthCredential — success", () => {
  it("refreshes once, preserves the connection and projects its own receipt", async () => {
    const harness = createHarness();
    await seedActive(harness);

    const receipt = await refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps);

    expect(receipt).toEqual({
      platform: OAUTH_PLATFORM,
      action: "refreshed",
      revision: 2,
      configured: true,
      readiness: "ready",
      expiresAt: NEW_EXPIRY,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(harness.store.counts.acquireRefresh).toBe(1);
    expect(harness.store.counts.completeRefresh).toBe(1);
    expect(harness.store.counts.markReconnectRequired).toBe(0);
    expect(harness.driver.refreshes).toHaveLength(1);
    expect(harness.driver.refreshes[0]?.now).toBe(OAUTH_NOW);
    expect(Array.from(harness.driver.refreshes[0]?.plaintext ?? [])).toEqual(
      Array.from(NATIVE_PAYLOAD),
    );
    expect(harness.driver.canRefreshCalls()).toBe(1);

    // The lease request carries the observed revision and the exact window.
    expect(harness.store.acquisitions[0]).toMatchObject({
      platform: OAUTH_PLATFORM,
      expectedRevision: 1,
      leaseToken: "lease-token-1",
      now: LEASE_START,
      leaseDurationMs: 60_000,
    });
    // The commit uses the same lease and revision and the safe next generation.
    expect(harness.store.refreshes[0]).toMatchObject({
      platform: OAUTH_PLATFORM,
      leaseToken: "lease-token-1",
      expectedRevision: 1,
      payloadRevision: 2,
      payloadSchemaVersion: 1,
      expiresAt: NEW_EXPIRY,
      target: EXISTING_TARGET,
    });
    // Encrypted under the active-slot AAD with the actual platform value.
    expect(harness.cipher.decryptContexts).toEqual([
      {
        purpose: "active_slot",
        recordId: OAUTH_PLATFORM,
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
        payloadRevision: 2,
      },
    ]);

    const slot = await harness.store.fake.credentials.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot).toMatchObject({
      status: "active",
      revision: 2,
      bindingId: "bind-existing",
      payloadRevision: 2,
      payloadSchemaVersion: 1,
      expiresAt: NEW_EXPIRY,
      target: EXISTING_TARGET,
      refreshLease: null,
      refreshState: "ready",
    });
  });
});

describe("refreshOAuthCredential — preflight", () => {
  it("performs no lease or outbound work for every preflight rejection", async () => {
    const cases: readonly {
      readonly label: string;
      readonly prepare: (harness: RefreshHarness) => Promise<void>;
      readonly expectedCode: string;
      readonly expectedReason: string;
      readonly input?: { readonly platform: Platform; readonly expectedRevision?: number | null };
    }[] = [
      {
        label: "empty slot",
        prepare: async () => undefined,
        expectedCode: "AUTH_CONFLICT",
        expectedReason: "no_refresh_payload",
      },
      {
        label: "revision mismatch",
        prepare: (harness) => seedActive(harness),
        input: { platform: OAUTH_PLATFORM, expectedRevision: 7 },
        expectedCode: "AUTH_CONFLICT",
        expectedReason: "revision_mismatch",
      },
      {
        label: "reconnect required",
        prepare: (harness) => seedReconnectRequired(harness),
        expectedCode: "AUTH_CONFLICT",
        expectedReason: "reconnect_required",
      },
      {
        label: "live lease",
        prepare: (harness) => seedLiveLease(harness),
        expectedCode: "AUTH_IN_PROGRESS",
        expectedReason: "lease_held",
      },
      {
        label: "expired unresolved lease",
        prepare: async (harness) => {
          await seedLiveLease(harness);
          harness.clock.set(LATE);
        },
        expectedCode: "AUTH_CONFLICT",
        expectedReason: "reconnect_required",
      },
    ];

    for (const entry of cases) {
      const harness = createHarness();
      await entry.prepare(harness);

      const failure = await expectAuthFailure(
        refreshOAuthCredential(entry.input ?? { platform: OAUTH_PLATFORM }, harness.deps),
      );

      expect(failure.code, entry.label).toBe(entry.expectedCode);
      expect(failure.reason, entry.label).toBe(entry.expectedReason);
      expect(harness.store.counts.acquireRefresh, entry.label).toBe(0);
      expect(harness.driver.refreshes, entry.label).toEqual([]);
      expect(harness.store.counts.completeRefresh, entry.label).toBe(0);
    }
  });

  it("refuses a tombstoned slot, an unreadable payload or a missing capability", async () => {
    const tombstone = createHarness();
    await tombstone.store.fake.credentials.compareAndSetSlot({
      platform: OAUTH_PLATFORM,
      expectedRevision: 0,
      now: LEASE_START,
      change: { kind: "remove" },
    });
    const tombstoneFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, tombstone.deps),
    );
    expect(tombstoneFailure.reason).toBe("no_refresh_payload");
    expect(tombstone.store.counts.acquireRefresh).toBe(0);

    const wrongKey = createHarness();
    await seedActive(wrongKey, { cipher: createTestCipher("other-key") });
    const keyFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, wrongKey.deps),
    );
    expect(keyFailure.code).toBe("INSTANCE_NOT_READY");
    expect(keyFailure.reason).toBe("cipher_unavailable");
    expect(wrongKey.store.counts.acquireRefresh).toBe(0);
    expect(wrongKey.driver.refreshes).toEqual([]);

    const noCapability = createHarness();
    await seedActive(noCapability);
    noCapability.driver.setCanRefresh(false);
    const capabilityFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, noCapability.deps),
    );
    expect(capabilityFailure.reason).toBe("no_refresh_payload");
    expect(noCapability.store.counts.acquireRefresh).toBe(0);
    expect(noCapability.driver.refreshes).toEqual([]);

    const noDriver = createHarness({ drivers: createRefreshResolverSpy({}) });
    await seedActive(noDriver);
    const driverFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, noDriver.deps),
    );
    expect(driverFailure.reason).toBe("no_refresh_payload");
    expect(noDriver.store.counts.acquireRefresh).toBe(0);
  });

  it("checks the generation bound before any lease", async () => {
    const harness = createHarness();
    await seedActive(harness, { payloadRevision: Number.MAX_SAFE_INTEGER });

    const failure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("payload_generation_overflow");
    expect(harness.store.counts.acquireRefresh).toBe(0);
    expect(harness.driver.refreshes).toEqual([]);
  });
});

/** A competing completion: seed an awaiting-confirmation operation and activate it. */
async function completeCompeteingConnection(harness: RefreshHarness): Promise<void> {
  await harness.store.fake.credentials.createAuthOperation({
    operationId: "op-compete",
    platform: OAUTH_PLATFORM,
    now: LEASE_START,
    expectedRevision: 1,
    canonicalCallbackUrl: "https://worker.example/v1/auth/x/callback",
    startConfigBinding: "config-binding-1",
    oauthState: "state-compete",
    requestToken: null,
    requestSecret: null,
    requestSecretPurpose: null,
    requestSecretRevision: null,
    expiresAt: "2026-09-23T00:30:00.000Z",
  });
  await harness.store.fake.credentials.claimOAuthCallback({
    platform: OAUTH_PLATFORM,
    oauthState: "state-compete",
    requestToken: null,
    now: LEASE_START,
    currentConfigBinding: "config-binding-1",
  });
  await harness.store.fake.credentials.saveCandidate({
    operationId: "op-compete",
    platform: OAUTH_PLATFORM,
    now: LEASE_START,
    outcome: {
      kind: "candidate",
      phase: "awaiting_confirmation",
      candidateEnvelope: testEnvelope("compete"),
      candidatePayloadRevision: 1,
      candidatePayloadSchemaVersion: 1,
      candidateTarget: null,
      missingFields: [],
    },
  });
  const activated = await harness.store.fake.credentials.activateCandidate({
    operationId: "op-compete",
    platform: OAUTH_PLATFORM,
    now: LEASE_START,
    expectedRevision: 1,
    bindingId: "bind-complete",
    currentConfigBinding: "config-binding-1",
    envelope: testEnvelope("complete"),
    payloadRevision: 1,
    payloadSchemaVersion: 1,
    expiresAt: null,
    target: null,
    receipt: {
      platform: OAUTH_PLATFORM,
      operationId: "op-compete",
      stored: true,
      revision: 2,
      configured: true,
      readiness: "ready",
    },
  });
  expect(activated.kind).toBe("activated");
}

describe("refreshOAuthCredential — lease outcomes and concurrency", () => {
  it("lets exactly one of two competing refreshes reach the provider", async () => {
    const harness = createHarness();
    await seedActive(harness);

    const results = await Promise.allSettled([
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(harness.driver.refreshes).toHaveLength(1);
    expect(harness.store.counts.completeRefresh).toBe(1);
    const loser = (rejected[0] as PromiseRejectedResult).reason as AuthUseCaseError;
    expect(loser.code).toBe("AUTH_IN_PROGRESS");
    expect(loser.reason).toBe("lease_held");
  });

  it("never exchanges when the lease result is unknown or throwing", async () => {
    const unknown = createHarness();
    await seedActive(unknown);
    unknown.store.fake.faults.inject({ refreshClaimResultUnknownOnce: true });
    const unknownFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, unknown.deps),
    );
    expect(unknownFailure.code).toBe("STORE_UNAVAILABLE");
    expect(unknown.driver.refreshes).toEqual([]);

    const committed = createHarness();
    await seedActive(committed);
    committed.store.fake.faults.inject({ refreshClaimCommittedUnknownOnce: true });
    const committedFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, committed.deps),
    );
    expect(committedFailure.code).toBe("STORE_UNAVAILABLE");
    expect(committed.driver.refreshes).toEqual([]);
    // The lease itself committed, so a second attempt sees it as held.
    const held = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, committed.deps),
    );
    expect(held.code).toBe("AUTH_IN_PROGRESS");
    expect(committed.driver.refreshes).toEqual([]);

    const throwing = createHarness();
    await seedActive(throwing);
    throwing.store.failNextAcquire(new StoreUnavailable("SENTINEL_ACQUIRE"));
    const throwingFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, throwing.deps),
    );
    expect(throwingFailure.code).toBe("STORE_UNAVAILABLE");
    expect(throwingFailure.message).not.toContain("SENTINEL_ACQUIRE");
    expect(throwing.driver.refreshes).toEqual([]);
  });

  it("stops when the lease window elapses before the exchange, after it, or during encryption", async () => {
    const beforeExchange = createHarness();
    await seedActive(beforeExchange);
    beforeExchange.store.afterAcquire(async () => {
      beforeExchange.clock.set(LATE);
    });
    const beforeFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, beforeExchange.deps),
    );
    expect(beforeFailure.code).toBe("AUTH_CONFLICT");
    expect(beforeFailure.reason).toBe("reconnect_required");
    expect(beforeExchange.driver.refreshes).toEqual([]);
    expect(beforeExchange.store.counts.markReconnectRequired).toBe(1);
    expect(beforeExchange.store.reconnectFailures[0]).toMatchObject({
      leaseToken: "lease-token-1",
      expectedRevision: 1,
      reason: "unknown_result",
    });

    const afterExchange = createHarness();
    await seedActive(afterExchange);
    const baseDriver = afterExchange.driver.driver;
    const wrappingDriver: OAuthRefreshDriver = {
      platform: baseDriver.platform,
      canRefresh: baseDriver.canRefresh,
      refresh: async (input) => {
        const result = await baseDriver.refresh(input);
        afterExchange.clock.set(LATE);
        return result;
      },
    };
    const wrappingResolver: OAuthRefreshDriverResolver = () => wrappingDriver;
    const afterFailure = await expectAuthFailure(
      refreshOAuthCredential(
        { platform: OAUTH_PLATFORM },
        { ...afterExchange.deps, drivers: wrappingResolver },
      ),
    );
    expect(afterFailure.reason).toBe("reconnect_required");
    expect(afterExchange.store.counts.completeRefresh).toBe(0);
    expect(afterExchange.store.counts.markReconnectRequired).toBe(1);

    const duringEncryption = createHarness();
    await seedActive(duringEncryption);
    const inner = createTestCipher();
    const cipher: CredentialCipher = {
      kind: inner.kind,
      keyId: inner.keyId,
      encrypt: async (plaintext, context) => {
        duringEncryption.clock.set(LATE);
        return inner.encrypt(plaintext, context);
      },
      decrypt: (envelope, context) => inner.decrypt(envelope, context),
    };
    const duringFailure = await expectAuthFailure(
      refreshOAuthCredential(
        { platform: OAUTH_PLATFORM },
        { ...duringEncryption.deps, getCipher: () => cipher },
      ),
    );
    expect(duringFailure.reason).toBe("reconnect_required");
    expect(duringEncryption.driver.refreshes).toHaveLength(1);
    expect(duringEncryption.store.counts.completeRefresh).toBe(0);
    expect(duringEncryption.store.counts.markReconnectRequired).toBe(1);
  });

  it("loses the commit cleanly when a set, remove or complete wins", async () => {
    for (const winner of ["set", "remove", "complete"] as const) {
      const harness = createHarness();
      await seedActive(harness);
      harness.store.beforeRefreshCommit(async () => {
        if (winner === "complete") {
          await completeCompeteingConnection(harness);
          return;
        }
        await harness.store.fake.credentials.compareAndSetSlot({
          platform: OAUTH_PLATFORM,
          expectedRevision: 1,
          now: LEASE_START,
          change:
            winner === "remove"
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
        refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
      );

      expect(failure.reason, winner).toBe("revision_mismatch");
      expect(failure.code, winner).toBe("AUTH_CONFLICT");
      expect(harness.store.counts.completeRefresh, winner).toBe(1);
      expect(harness.store.counts.markReconnectRequired, winner).toBe(0);
      const slot = await harness.store.fake.credentials.readSlot({ platform: OAUTH_PLATFORM });
      expect(slot.revision, winner).toBe(2);
      if (winner === "set") {
        expect(slot.bindingId).toBe("bind-winner");
      }
      if (winner === "remove") {
        expect(slot.status).toBe("tombstone");
      }
      if (winner === "complete") {
        expect(slot.bindingId).toBe("bind-complete");
      }
    }
  });
});

describe("refreshOAuthCredential — failed and malformed exchanges", () => {
  it("records reconnect_required for a rejected, unknown or malformed exchange", async () => {
    const rejected = createHarness();
    await seedActive(rejected);
    rejected.driver.failNextRefresh(new OAuthDriverError("denied"));
    const rejectedFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, rejected.deps),
    );
    expect(rejectedFailure.code).toBe("PROVIDER_ERROR");
    expect(rejectedFailure.reason).toBe("provider_error");
    expect(rejected.driver.refreshes).toHaveLength(1);
    expect(rejected.store.reconnectFailures[0]).toMatchObject({
      reason: "provider_rejected",
      leaseToken: "lease-token-1",
      expectedRevision: 1,
    });
    const rejectedSlot = await rejected.store.fake.credentials.readSlot({
      platform: OAUTH_PLATFORM,
    });
    expect(rejectedSlot.refreshState).toBe("reconnect_required");
    expect(rejectedSlot.refreshLease).toBeNull();
    expect(rejected.store.counts.completeRefresh).toBe(0);

    const unknown = createHarness();
    await seedActive(unknown);
    unknown.driver.failNextRefresh(new Error("SENTINEL_REFRESH_BODY"));
    const unknownFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, unknown.deps),
    );
    expect(unknownFailure.message).not.toContain("SENTINEL_REFRESH_BODY");
    expect(unknown.store.reconnectFailures[0]?.reason).toBe("unknown_result");

    const malformed = createHarness();
    await seedActive(malformed);
    malformed.driver.setRefreshResult({
      plaintext: "not-bytes" as unknown as Uint8Array,
      expiresAt: null,
    });
    const malformedFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, malformed.deps),
    );
    expect(malformedFailure.code).toBe("PROVIDER_ERROR");
    expect(malformedFailure.reason).toBe("invalid_driver_response");
    expect(malformed.store.reconnectFailures[0]?.reason).toBe("invalid_response");
    expect(malformed.store.counts.completeRefresh).toBe(0);

    for (const result of [
      { plaintext: new Uint8Array(0), expiresAt: null },
      { plaintext: bodyBytes({ access_token: "x" }), expiresAt: "2026-09-23T00:00:00Z" },
      { plaintext: new Uint8Array(64 * 1024 + 1), expiresAt: null },
    ]) {
      const boundary = createHarness();
      await seedActive(boundary);
      boundary.driver.setRefreshResult(result);
      const failure = await expectAuthFailure(
        refreshOAuthCredential({ platform: OAUTH_PLATFORM }, boundary.deps),
      );
      expect(failure.reason, JSON.stringify(result.expiresAt)).toBe("invalid_driver_response");
      expect(boundary.store.reconnectFailures[0]?.reason).toBe("invalid_response");
      expect(boundary.store.counts.completeRefresh).toBe(0);
    }
  });

  it("keeps the primary failure when the reconnect record cannot be written", async () => {
    const harness = createHarness();
    await seedActive(harness);
    harness.driver.failNextRefresh(new OAuthDriverError("denied"));
    harness.store.failNextReconnect(new StoreUnavailable("SENTINEL_RECONNECT_WRITE"));

    const failure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(failure.reason).toBe("provider_error");
    expect(failure.message).not.toContain("SENTINEL_RECONNECT_WRITE");
    expect(harness.store.counts.completeRefresh).toBe(0);
  });
});

describe("refreshOAuthCredential — failures after the exchange", () => {
  it("records a fenced reconnect when encryption fails after a successful exchange", async () => {
    const harness = createHarness();
    await seedActive(harness);
    const inner = createTestCipher();
    const cipher: CredentialCipher = {
      kind: inner.kind,
      keyId: inner.keyId,
      encrypt: async () => {
        throw new StoreUnavailable("SENTINEL_ENCRYPT_AFTER_EXCHANGE");
      },
      decrypt: (envelope, context) => inner.decrypt(envelope, context),
    };

    const failure = await expectAuthFailure(
      refreshOAuthCredential(
        { platform: OAUTH_PLATFORM },
        { ...harness.deps, getCipher: () => cipher },
      ),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("cipher_unavailable");
    expect(failure.message).not.toContain("SENTINEL_ENCRYPT_AFTER_EXCHANGE");
    expect(harness.driver.refreshes).toHaveLength(1);
    expect(harness.store.counts.completeRefresh).toBe(0);
    expect(harness.store.reconnectFailures[0]).toMatchObject({ reason: "unknown_result" });
  });

  it("reports a committed-but-lost commit without damaging the new revision", async () => {
    const harness = createHarness();
    await seedActive(harness);
    harness.store.commitRefreshThenThrow();

    const failure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_LOST_REFRESH_ACK");
    expect(harness.store.counts.completeRefresh).toBe(1);
    // The fenced failure record was attempted; the committed slot rejected it,
    // and the new revision is untouched.
    expect(harness.store.counts.markReconnectRequired).toBe(1);
    const slot = await harness.store.fake.credentials.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot.revision).toBe(2);
    expect(slot.payloadRevision).toBe(2);
    expect(slot.refreshLease).toBeNull();
    expect(slot.refreshState).toBe("ready");
    expect(slot.bindingId).toBe("bind-existing");
  });

  it("fences a store failure that happened before the commit applied", async () => {
    const harness = createHarness();
    await seedActive(harness);
    harness.store.failNextRefreshCommit(new StoreUnavailable("SENTINEL_COMMIT_WRITE"));

    const failure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.message).not.toContain("SENTINEL_COMMIT_WRITE");
    expect(harness.store.counts.markReconnectRequired).toBe(1);
    const slot = await harness.store.fake.credentials.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot.revision).toBe(1);
    expect(slot.refreshState).toBe("reconnect_required");
    expect(slot.refreshLease).toBeNull();
  });

  it("never treats an arbitrary commit result as success", async () => {
    const harness = createHarness();
    await seedActive(harness);
    const broken: CredentialStore = {
      ...harness.store.store,
      async completeRefresh() {
        return { kind: "something-else" } as never;
      },
    };

    const failure = await expectAuthFailure(
      refreshOAuthCredential(
        { platform: OAUTH_PLATFORM },
        { ...harness.deps, credentials: broken },
      ),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("unexpected_result");
  });

  it("does not poison a replacement connection when the commit sees a lost lease", async () => {
    const harness = createHarness();
    await seedActive(harness);
    harness.store.beforeRefreshCommit(async () => {
      // Another holder finished first: the lease is gone.
      await harness.store.fake.credentials.markReconnectRequired({
        platform: OAUTH_PLATFORM,
        leaseToken: "lease-token-1",
        expectedRevision: 1,
        now: LEASE_START,
        reason: "unknown_result",
      });
    });

    const failure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("lease_mismatch");
    // This caller marks nothing: the competing holder already recorded its own
    // failure, and a lost lease is never permission to mark a replacement
    // connection unhealthy.
    expect(harness.store.counts.markReconnectRequired).toBe(0);
    const slot = await harness.store.fake.credentials.readSlot({ platform: OAUTH_PLATFORM });
    expect(slot.refreshState).toBe("reconnect_required");
  });
});

describe("refreshOAuthCredential — input and hostile-driver safety", () => {
  it("rejects malformed input before reading the slot", async () => {
    const invalidInputs: readonly (readonly [unknown, string])[] = [
      [null, "INVALID_REQUEST"],
      [{ platform: "not-a-platform" }, "INVALID_REQUEST"],
      [{ platform: OAUTH_PLATFORM, expectedRevision: -1 }, "INVALID_REQUEST"],
      [{ platform: OAUTH_PLATFORM, expectedRevision: 1.5 }, "INVALID_REQUEST"],
    ];
    for (const [input, expectedCode] of invalidInputs) {
      const harness = createHarness();
      const failure = await expectAuthFailure(
        refreshOAuthCredential(
          input as Parameters<typeof refreshOAuthCredential>[0],
          harness.deps,
        ),
      );
      expect(failure.code, JSON.stringify(input)).toBe(expectedCode);
      expect(harness.store.counts.readSlot).toBe(0);
      expect(harness.store.counts.acquireRefresh).toBe(0);
    }
  });

  it("never lets a hostile slot, forged failure or thenable preflight escape", async () => {
    const hostileSlot = createHarness();
    const throwing = slotSnapshot();
    Object.defineProperty(throwing, "refreshState", {
      enumerable: true,
      get() {
        throw new Error("SENTINEL_SLOT_GETTER");
      },
    });
    hostileSlot.store.returnNextSlot(throwing);
    const slotFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, hostileSlot.deps),
    );
    expect(slotFailure.code).toBe("STORE_UNAVAILABLE");
    expect(slotFailure.reason).toBe("corrupt_record");
    expect(slotFailure.message).not.toContain("SENTINEL_SLOT_GETTER");
    expect(hostileSlot.store.counts.acquireRefresh).toBe(0);

    const forged = createHarness();
    await seedActive(forged);
    const forgedError = Object.create(AuthUseCaseError.prototype) as AuthUseCaseError;
    Object.defineProperty(forgedError, "code", {
      get() {
        throw new Error("SENTINEL_FORGED_REFRESH_CODE");
      },
    });
    Object.defineProperty(forgedError, "reason", {
      get() {
        throw new Error("SENTINEL_FORGED_REFRESH_REASON");
      },
    });
    forged.driver.failNextCanRefresh(forgedError);
    const forgedFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, forged.deps),
    );
    expect(forgedFailure.code).toBe("INSTANCE_NOT_READY");
    expect(forgedFailure.reason).toBe("invalid_driver_response");
    expect(forgedFailure.message).not.toContain("SENTINEL_FORGED_REFRESH");
    expect(forged.store.counts.acquireRefresh).toBe(0);

    const thenable = createHarness();
    await seedActive(thenable);
    thenable.driver.setCanRefreshRaw(Promise.reject(new Error("SENTINEL_THENABLE_PREFLIGHT")));
    const thenableFailure = await expectAuthFailure(
      refreshOAuthCredential({ platform: OAUTH_PLATFORM }, thenable.deps),
    );
    expect(thenableFailure.code).toBe("INSTANCE_NOT_READY");
    expect(thenableFailure.reason).toBe("invalid_driver_response");
    expect(thenable.store.counts.acquireRefresh).toBe(0);
    expect(thenable.driver.refreshes).toEqual([]);
  });

  it("uses the captured driver methods when the injected object mutates during the lease", async () => {
    const harness = createHarness();
    await seedActive(harness);
    const original = harness.driver.driver as unknown as {
      refresh: (...args: never[]) => unknown;
    };
    let replacementCalled = false;
    harness.store.afterAcquire(async () => {
      original.refresh = () => {
        replacementCalled = true;
        throw new Error("SENTINEL_REPLACED_REFRESH");
      };
    });

    const receipt = await refreshOAuthCredential({ platform: OAUTH_PLATFORM }, harness.deps);

    expect(receipt.action).toBe("refreshed");
    expect(replacementCalled).toBe(false);
    expect(harness.driver.refreshes).toHaveLength(1);
  });
});
