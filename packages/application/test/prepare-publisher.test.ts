/**
 * Task T6b — portable preparation tests.
 *
 * The store is the frozen snapshot fake; the cipher, strategy registry and
 * instance configuration are spies composed around it, so every call count and
 * AAD context asserted here comes from the use case itself.
 */
import { describe, expect, it } from "vitest";

import type { Platform, Publisher, PublishResult } from "@syndroo/core";

import {
  InvalidContractInputError,
  StoreUnavailable,
  encodeBindingMaterial,
  type CipherContext,
  type CredentialCipher,
  type CredentialStore,
  type EncryptedSlotSnapshot,
  type PlatformConfigView,
  type PlatformStrategyRegistry,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
  type SlotChange,
  type SlotMutation,
} from "../src/index.js";
import { AuthUseCaseError, authFailure, preserveAuthFailure } from "../src/use-cases/auth-errors.js";
import {
  activeSlotContext,
  createPreparePublisher,
  preparePublisher,
  type PreparePublisherDependencies,
} from "../src/use-cases/prepare-publisher.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  createTestCipher,
  testEnvelope,
} from "../src/testing/index.js";

function stubPublisher(platform: Platform): Publisher {
  return {
    name: `${platform}-provider`,
    async publish(): Promise<PublishResult> {
      return { externalId: "stub" };
    },
  };
}

interface StrategySpy {
  readonly strategy: PublisherStrategy;
  readonly inputs: PublisherPrepareInput[];
}

/** Minimal stand-in for the pure strategy: blocks on an unreadable active slot. */
function createStrategySpy(): StrategySpy {
  const inputs: PublisherPrepareInput[] = [];
  const strategy: PublisherStrategy = {
    prepare(input: PublisherPrepareInput): PublisherPreparation {
      inputs.push(input);
      const base = {
        platform: input.platform,
        oauthSupported: false,
        revision: input.slot.revision,
        expiresAt: null,
        missingFields: [] as readonly string[],
      };
      if (input.slot.status === "active" && input.plaintext === null) {
        return {
          kind: "blocked",
          reason: "unavailable",
          readiness: "unavailable",
          missingFields: [],
          status: { ...base, configured: false, source: "credential", readiness: "unavailable" },
        };
      }
      const source = input.slot.status === "active" ? "credential" : "env";
      return {
        kind: "ready",
        prepared: {
          platform: input.platform,
          publisher: stubPublisher(input.platform),
          status: { ...base, configured: true, source, readiness: "ready" },
          target: null,
          slotBindingId: input.slot.bindingId,
          bindingMaterial: encodeBindingMaterial({
            platform: input.platform,
            source,
            fields: [["slotBinding", input.slot.bindingId]],
          }),
          credentialRevision: input.slot.revision,
          credentialSource: source,
        },
      };
    },
  };
  return { strategy, inputs };
}

interface CipherSpy {
  readonly cipher: CredentialCipher;
  readonly decryptContexts: CipherContext[];
  readonly encryptContexts: CipherContext[];
}

function createCipherSpy(inner: CredentialCipher): CipherSpy {
  const decryptContexts: CipherContext[] = [];
  const encryptContexts: CipherContext[] = [];
  const cipher: CredentialCipher = {
    kind: inner.kind,
    keyId: inner.keyId,
    async encrypt(payload, context) {
      encryptContexts.push(context);
      return inner.encrypt(payload, context);
    },
    async decrypt(envelope, context) {
      decryptContexts.push(context);
      return inner.decrypt(envelope, context);
    },
  };
  return { cipher, decryptContexts, encryptContexts };
}

interface StoreSpy {
  readonly store: CredentialStore;
  readonly reads: Platform[];
  readonly mutations: SlotMutation[];
  failNextRead(error: Error): void;
  returnNextSnapshot(snapshot: unknown): void;
}

function createStoreSpy(inner: CredentialStore): StoreSpy {
  const reads: Platform[] = [];
  const mutations: SlotMutation[] = [];
  let readFailure: Error | null = null;
  let nextSnapshot: unknown = null;
  const store: CredentialStore = {
    ...inner,
    async readSlot(input) {
      reads.push(input.platform);
      if (nextSnapshot !== null) {
        const snapshot = nextSnapshot;
        nextSnapshot = null;
        return snapshot as EncryptedSlotSnapshot;
      }
      if (readFailure !== null) {
        const error = readFailure;
        readFailure = null;
        throw error;
      }
      return inner.readSlot(input);
    },
    async compareAndSetSlot(input) {
      mutations.push(input);
      return inner.compareAndSetSlot(input);
    },
  };
  return {
    store,
    reads,
    mutations,
    failNextRead: (error: Error) => {
      readFailure = error;
    },
    returnNextSnapshot: (snapshot: unknown) => {
      nextSnapshot = snapshot;
    },
  };
}

interface Harness {
  readonly fake: ReturnType<typeof createSnapshotFake>;
  readonly store: StoreSpy;
  readonly strategy: StrategySpy;
  readonly cipher: CipherSpy;
  readonly deps: PreparePublisherDependencies;
  readonly cipherLookups: () => number;
  readonly configCalls: Platform[];
}

function configView(platform: Platform): PlatformConfigView {
  return { platform, values: { X_API_KEY: "env-app-key" }, publicUrl: null };
}

function emptySnapshot(platform: Platform): EncryptedSlotSnapshot {
  return {
    platform,
    status: "empty",
    revision: 0,
    bindingId: null,
    envelope: null,
    payloadRevision: null,
    payloadSchemaVersion: null,
    expiresAt: null,
    target: null,
    refreshLease: null,
    refreshState: "ready",
    lastRefreshCommitFingerprint: null,
    updatedAt: null,
  };
}

function createHarness(options: { readonly getCipher?: () => CredentialCipher } = {}): Harness {
  const fake = createSnapshotFake();
  const store = createStoreSpy(fake.credentials);
  const strategy = createStrategySpy();
  const cipher = createCipherSpy(createTestCipher());
  const configCalls: Platform[] = [];
  let cipherLookups = 0;
  const registry: PlatformStrategyRegistry = {
    platforms: ["x", "threads", "linkedin"],
    strategyFor(platform: Platform): PublisherStrategy {
      if (platform !== "x" && platform !== "threads" && platform !== "linkedin") {
        throw new Error("no installed strategy");
      }
      return strategy.strategy;
    },
  };
  const deps: PreparePublisherDependencies = {
    credentials: store.store,
    getCipher:
      options.getCipher ??
      (() => {
        cipherLookups += 1;
        return cipher.cipher;
      }),
    strategies: registry,
    configFor: (platform: Platform) => {
      configCalls.push(platform);
      return configView(platform);
    },
  };
  return { fake, store, strategy, cipher, deps, cipherLookups: () => cipherLookups, configCalls };
}

async function seedActiveSlot(
  harness: Harness,
  platform: Platform,
  options: {
    readonly plaintext: Uint8Array;
    readonly payloadRevision: number;
    readonly context?: CipherContext;
    readonly envelope?: ReturnType<typeof testEnvelope>;
    readonly payloadSchemaVersion?: number;
  },
): Promise<void> {
  const context: CipherContext = options.context ?? {
    purpose: "active_slot",
    recordId: platform,
    platform,
    payloadSchemaVersion: 1,
    payloadRevision: options.payloadRevision,
  };
  const envelope = options.envelope ?? (await createTestCipher().encrypt(options.plaintext, context));
  const change: Extract<SlotChange, { kind: "set" }> = {
    kind: "set",
    bindingId: "bind-seeded",
    envelope,
    payloadRevision: options.payloadRevision,
    payloadSchemaVersion: options.payloadSchemaVersion ?? 1,
    expiresAt: null,
    target: null,
  };
  const result = await harness.fake.credentials.compareAndSetSlot({
    platform,
    expectedRevision: 0,
    now: FIXTURE_NOW,
    change,
  });
  expect(result.kind).toBe("applied");
}

async function seedTombstone(harness: Harness, platform: Platform): Promise<void> {
  const result = await harness.fake.credentials.compareAndSetSlot({
    platform,
    expectedRevision: 0,
    now: FIXTURE_NOW,
    change: { kind: "remove" },
  });
  expect(result.kind).toBe("applied");
}

function activeContextFor(platform: Platform, payloadRevision: number): CipherContext {
  return {
    purpose: "active_slot",
    // Runtime convention: the record id is the platform value itself.
    recordId: platform,
    platform,
    payloadSchemaVersion: 1,
    payloadRevision,
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

describe("preparePublisher — trusted read", () => {
  it("decrypts an active payload with the trusted slot identity", async () => {
    const harness = createHarness();
    const plaintext = new TextEncoder().encode('{"access_token":"stored-token"}');
    await seedActiveSlot(harness, "x", { plaintext, payloadRevision: 4 });

    const preparation = await preparePublisher("x", FIXTURE_NOW, harness.deps);

    expect(preparation.kind).toBe("ready");
    expect(harness.cipher.decryptContexts).toEqual([activeContextFor("x", 4)]);
    expect(harness.strategy.inputs).toHaveLength(1);
    const input = harness.strategy.inputs[0];
    expect(input?.platform).toBe("x");
    expect(input?.now).toBe(FIXTURE_NOW);
    expect(input?.slot.platform).toBe("x");
    expect(input?.slot.revision).toBe(1);
    expect(Array.from(input?.plaintext ?? [])).toEqual(Array.from(plaintext));
    expect(input?.config.platform).toBe("x");
    expect(harness.configCalls).toEqual(["x"]);
  });

  it("uses the platform value as the AAD record id for every platform", async () => {
    for (const platform of ["x", "linkedin"] as const) {
      const harness = createHarness();
      await seedActiveSlot(harness, platform, {
        plaintext: new TextEncoder().encode('{"access_token":"stored-token"}'),
        payloadRevision: 2,
      });

      await preparePublisher(platform, FIXTURE_NOW, harness.deps);

      expect(harness.cipher.decryptContexts).toEqual([
        {
          purpose: "active_slot",
          recordId: platform,
          platform,
          payloadSchemaVersion: 1,
          payloadRevision: 2,
        },
      ]);
    }
  });

  it("prepares empty and tombstoned slots without touching a cipher", async () => {
    const emptyHarness = createHarness();
    const emptyPreparation = await preparePublisher("x", FIXTURE_NOW, emptyHarness.deps);
    expect(emptyPreparation.kind).toBe("ready");
    expect(emptyHarness.cipherLookups()).toBe(0);
    expect(emptyHarness.cipher.decryptContexts).toEqual([]);

    const tombstoneHarness = createHarness();
    await seedTombstone(tombstoneHarness, "x");
    const tombstonePreparation = await preparePublisher("x", FIXTURE_NOW, tombstoneHarness.deps);
    expect(tombstonePreparation.kind).toBe("ready");
    expect(tombstoneHarness.cipherLookups()).toBe(0);
    expect(tombstoneHarness.strategy.inputs[0]?.plaintext).toBeNull();
    expect(tombstoneHarness.strategy.inputs[0]?.slot.status).toBe("tombstone");
  });

  it("writes nothing while preparing", async () => {
    const harness = createHarness();
    await seedActiveSlot(harness, "x", {
      plaintext: new TextEncoder().encode('{"access_token":"stored-token"}'),
      payloadRevision: 1,
    });
    const before = harness.fake.snapshot().slots;

    await preparePublisher("x", FIXTURE_NOW, harness.deps);
    await preparePublisher("x", FIXTURE_NOW, harness.deps);

    expect(harness.store.mutations).toEqual([]);
    expect(harness.fake.snapshot().slots).toEqual(before);
    expect(harness.cipher.encryptContexts).toEqual([]);
  });

  it("binds the dependencies through the helper", async () => {
    const harness = createHarness();
    const prepare = createPreparePublisher(harness.deps);

    const preparation = await prepare("x", FIXTURE_NOW);

    expect(preparation.kind).toBe("ready");
    if (preparation.kind === "ready") {
      expect(preparation.prepared.status).toMatchObject({
        platform: "x",
        configured: true,
        readiness: "ready",
        source: "env",
        revision: 0,
      });
      expect(preparation.prepared.publisher.name).toBe("x-provider");
    }
  });
});

describe("preparePublisher — selected-slot failure", () => {
  it("blocks an unreadable active payload without selecting Env credentials", async () => {
    const harness = createHarness();
    // Stored under a different generation, so the trusted AAD cannot match.
    await seedActiveSlot(harness, "x", {
      plaintext: new TextEncoder().encode('{"access_token":"stored-token"}'),
      payloadRevision: 1,
      context: activeContextFor("x", 9),
    });

    const preparation = await preparePublisher("x", FIXTURE_NOW, harness.deps);

    expect(preparation.kind).toBe("blocked");
    if (preparation.kind === "blocked") {
      expect(preparation.reason).toBe("unavailable");
      expect(preparation.status.revision).toBe(1);
      expect(preparation.status.configured).toBe(false);
      expect(preparation.status.source).toBe("credential");
    }
    // The strategy saw "no plaintext", never an Env-derived group.
    expect(harness.strategy.inputs[0]?.plaintext).toBeNull();
    expect(harness.strategy.inputs[0]?.slot.status).toBe("active");
    expect(harness.cipher.decryptContexts).toEqual([activeContextFor("x", 1)]);
  });

  it("blocks when the cipher is unavailable instead of throwing", async () => {
    const harness = createHarness({
      getCipher: () => {
        throw new StoreUnavailable("SENTINEL_CIPHER_UNAVAILABLE");
      },
    });
    await seedActiveSlot(harness, "x", {
      plaintext: new TextEncoder().encode('{"access_token":"stored-token"}'),
      payloadRevision: 2,
    });

    const preparation = await preparePublisher("x", FIXTURE_NOW, harness.deps);

    expect(preparation.kind).toBe("blocked");
    expect(JSON.stringify(preparation)).not.toContain("SENTINEL_CIPHER_UNAVAILABLE");
    expect(harness.strategy.inputs[0]?.plaintext).toBeNull();
    expect(harness.store.mutations).toEqual([]);
  });

  it("blocks when a throwing decrypt error carries a sentinel", async () => {
    const inner = createTestCipher();
    const harness = createHarness({
      getCipher: () => ({
        kind: inner.kind,
        keyId: inner.keyId,
        encrypt: inner.encrypt,
        async decrypt(): Promise<Uint8Array> {
          throw new Error("SENTINEL_DECRYPT_FAILURE");
        },
      }),
    });
    await seedActiveSlot(harness, "x", {
      plaintext: new TextEncoder().encode('{"access_token":"stored-token"}'),
      payloadRevision: 1,
    });

    const preparation = await preparePublisher("x", FIXTURE_NOW, harness.deps);

    expect(preparation.kind).toBe("blocked");
    expect(JSON.stringify(preparation)).not.toContain("SENTINEL_DECRYPT_FAILURE");
  });

  it("treats a record without a usable active context as unreadable", async () => {
    const harness = createHarness();
    await seedActiveSlot(harness, "x", {
      plaintext: new TextEncoder().encode('{"access_token":"stored-token"}'),
      payloadRevision: 1,
      payloadSchemaVersion: 2,
    });

    const preparation = await preparePublisher("x", FIXTURE_NOW, harness.deps);

    expect(preparation.kind).toBe("blocked");
    expect(harness.cipher.decryptContexts).toEqual([]);
    expect(harness.strategy.inputs[0]?.plaintext).toBeNull();
  });
});

describe("preparePublisher — controlled failures", () => {
  it("reports a storage read failure without inventing revision 0", async () => {
    const harness = createHarness();
    harness.store.failNextRead(new StoreUnavailable("SENTINEL_STORE_READ"));

    const failure = await expectAuthFailure(preparePublisher("x", FIXTURE_NOW, harness.deps));

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_STORE_READ");
    expect(harness.strategy.inputs).toEqual([]);
    expect(harness.cipherLookups()).toBe(0);
  });

  it("rejects a snapshot from another platform before decrypting", async () => {
    const harness = createHarness();
    const foreign: EncryptedSlotSnapshot = {
      platform: "threads",
      status: "active",
      revision: 3,
      bindingId: "bind-foreign",
      envelope: testEnvelope("foreign"),
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: null,
      refreshLease: null,
      refreshState: "ready",
      lastRefreshCommitFingerprint: null,
      updatedAt: FIXTURE_NOW,
    };
    harness.store.returnNextSnapshot(foreign);

    const failure = await expectAuthFailure(preparePublisher("x", FIXTURE_NOW, harness.deps));

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("corrupt_record");
    expect(harness.cipherLookups()).toBe(0);
  });

  it("rejects malformed revision or status metadata", async () => {
    for (const snapshot of [
      { ...emptySnapshot("x"), revision: -1 },
      { ...emptySnapshot("x"), revision: 1.5 },
      { ...emptySnapshot("x"), status: "actve" },
    ]) {
      const harness = createHarness();
      harness.store.returnNextSnapshot(snapshot);
      const failure = await expectAuthFailure(preparePublisher("x", FIXTURE_NOW, harness.deps));
      expect(failure.reason).toBe("corrupt_record");
      expect(failure.code).toBe("STORE_UNAVAILABLE");
    }
  });

  it("never lets hostile snapshot getters escape", async () => {
    for (const property of ["platform", "revision", "status"] as const) {
      const harness = createHarness();
      const snapshot = emptySnapshot("x");
      Object.defineProperty(snapshot, property, {
        enumerable: true,
        get() {
          throw new Error("SENTINEL_SNAPSHOT_GETTER");
        },
      });
      harness.store.returnNextSnapshot(snapshot);

      const failure = await expectAuthFailure(preparePublisher("x", FIXTURE_NOW, harness.deps));

      expect(failure.reason).toBe("corrupt_record");
      expect(failure.message).not.toContain("SENTINEL_SNAPSHOT_GETTER");
    }
  });

  it("rejects an uninstalled platform with zero storage reads", async () => {
    const harness = createHarness();

    const failure = await expectAuthFailure(preparePublisher("mastodon", FIXTURE_NOW, harness.deps));

    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.reason).toBe("platform");
    expect(harness.store.reads).toEqual([]);
  });

  it("rejects a non-canonical observation instant", async () => {
    const harness = createHarness();

    await expect(
      preparePublisher("x", "2026-09-23T00:00:00Z", harness.deps),
    ).rejects.toBeInstanceOf(InvalidContractInputError);
    expect(harness.store.reads).toEqual([]);
  });

  it("never lets an injected strategy error escape", async () => {
    const harness = createHarness();
    harness.strategy.strategy.prepare = () => {
      throw new Error("SENTINEL_STRATEGY_FAILURE");
    };

    const failure = await expectAuthFailure(preparePublisher("x", FIXTURE_NOW, harness.deps));

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("unavailable");
    expect(failure.message).not.toContain("SENTINEL_STRATEGY_FAILURE");
  });

  it("never lets a failing configuration provider escape", async () => {
    const harness = createHarness();
    const failure = await expectAuthFailure(
      preparePublisher("x", FIXTURE_NOW, {
        ...harness.deps,
        configFor: () => {
          throw new Error("SENTINEL_CONFIG_PROVIDER");
        },
      }),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("unavailable");
    expect(failure.message).not.toContain("SENTINEL_CONFIG_PROVIDER");
  });
});

describe("activeSlotContext", () => {
  it("derives the fixed runtime identity from trusted metadata", () => {
    const slot = {
      ...emptySnapshot("threads"),
      status: "active" as const,
      bindingId: "bind-1",
      envelope: testEnvelope("seed"),
      payloadRevision: 6,
      payloadSchemaVersion: 1,
    };

    expect(activeSlotContext(slot)).toEqual(activeContextFor("threads", 6));
    expect(activeSlotContext({ ...slot, payloadSchemaVersion: 2 })).toBeNull();
    expect(activeSlotContext({ ...slot, payloadRevision: null })).toBeNull();
    expect(activeSlotContext({ ...slot, envelope: null })).toBeNull();
    expect(activeSlotContext({ ...slot, status: "tombstone" })).toBeNull();
  });
});

describe("fixed auth failures", () => {
  it("ignores forged instances and their messages", () => {
    const forged = new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
    expect(preserveAuthFailure(forged)).not.toBeNull();
    expect(preserveAuthFailure(forged)).not.toBe(forged);

    const unknownCode = Object.create(AuthUseCaseError.prototype) as AuthUseCaseError;
    Object.defineProperty(unknownCode, "code", { get: () => "NOT_A_CODE" });
    Object.defineProperty(unknownCode, "reason", { get: () => "not_a_reason" });
    expect(preserveAuthFailure(unknownCode)).toBeNull();
    expect(authFailure(unknownCode, "STORE_UNAVAILABLE", "store_unavailable").message).not.toContain(
      "NOT_A_CODE",
    );
  });

  it("never reads a hostile getter outside a guard", () => {
    const forged = Object.create(AuthUseCaseError.prototype) as AuthUseCaseError;
    Object.defineProperty(forged, "code", {
      get() {
        throw new Error("SENTINEL_FORGED_CODE");
      },
    });
    Object.defineProperty(forged, "reason", {
      get() {
        throw new Error("SENTINEL_FORGED_REASON");
      },
    });

    expect(preserveAuthFailure(forged)).toBeNull();
    const mapped = authFailure(forged, "STORE_UNAVAILABLE", "store_unavailable");
    expect(mapped.code).toBe("STORE_UNAVAILABLE");
    expect(mapped.reason).toBe("store_unavailable");
    expect(mapped.message).not.toContain("SENTINEL");
  });
});
