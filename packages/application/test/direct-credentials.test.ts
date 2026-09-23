/**
 * Task T6b — portable direct set/remove tests.
 *
 * The store is the frozen snapshot fake. Cipher, decoder, strategy registry and
 * instance configuration are spies composed around it, so call counts, AAD
 * contexts and the exact mutation the use case issued are asserted directly.
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
  type EncryptedCredential,
  type EncryptedSlotSnapshot,
  type PlatformConfigView,
  type PlatformStrategyRegistry,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
  type SlotChange,
  type SlotMutation,
} from "../src/index.js";
import { AuthUseCaseError } from "../src/use-cases/auth-errors.js";
import {
  removeDirectCredential,
  setDirectCredential,
  type DirectCredentialDecode,
  type DirectCredentialDecoder,
  type DirectCredentialDependencies,
} from "../src/use-cases/direct-credentials.js";
import { FIXTURE_NOW, createSnapshotFake, createTestCipher } from "../src/testing/index.js";

function bodyBytes(fields: Readonly<Record<string, string>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fields));
}

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

/** Stand-in for the pure strategy: a complete group or a non-empty Env config. */
function createStrategySpy(): StrategySpy {
  const inputs: PublisherPrepareInput[] = [];
  const strategy: PublisherStrategy = {
    prepare(input: PublisherPrepareInput): PublisherPreparation {
      inputs.push(input);
      const active = input.slot.status === "active";
      const hasEnv = Object.keys(input.config.values).length > 0;
      // A complete stored group still needs the runtime app fields (x/tumblr),
      // which is why storage succeeds while the receipt reports configuration.
      const configured = active ? input.plaintext !== null && hasEnv : hasEnv;
      const reason: "missing_credentials" | "needs_configuration" =
        active && input.plaintext !== null ? "needs_configuration" : "missing_credentials";
      const source = active ? "credential" : "env";
      const base = {
        platform: input.platform,
        oauthSupported: false,
        revision: input.slot.revision,
        expiresAt: input.slot.expiresAt ?? null,
      };
      if (!configured) {
        return {
          kind: "blocked",
          reason,
          readiness: reason,
          missingFields: ["X_ACCESS_TOKEN"],
          status: {
            ...base,
            configured: false,
            source,
            readiness: reason,
            missingFields: ["X_ACCESS_TOKEN"],
          },
        };
      }
      return {
        kind: "ready",
        prepared: {
          platform: input.platform,
          publisher: stubPublisher(input.platform),
          status: { ...base, configured: true, source, readiness: "ready", missingFields: [] },
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
  readonly encryptContexts: CipherContext[];
  readonly decryptContexts: CipherContext[];
}

function createCipherSpy(inner: CredentialCipher): CipherSpy {
  const encryptContexts: CipherContext[] = [];
  const decryptContexts: CipherContext[] = [];
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
  return { cipher, encryptContexts, decryptContexts };
}

interface StoreSpy {
  readonly store: CredentialStore;
  readonly reads: Platform[];
  readonly mutations: SlotMutation[];
  failNextRead(error: Error): void;
  returnNextSnapshot(snapshot: unknown): void;
}

interface HarnessOptions {
  readonly decode?: DirectCredentialDecoder;
  readonly getCipher?: () => CredentialCipher;
  readonly envValues?: Readonly<Record<string, string>>;
  readonly bindingId?: string;
  readonly beforeRead?: () => Promise<void>;
  readonly beforeCompareAndSet?: (input: SlotMutation) => Promise<void>;
  readonly afterCompareAndSet?: (input: SlotMutation) => void;
}

interface Harness {
  readonly fake: ReturnType<typeof createSnapshotFake>;
  readonly store: StoreSpy;
  readonly strategy: StrategySpy;
  readonly cipher: CipherSpy;
  readonly deps: DirectCredentialDependencies;
  readonly cipherLookups: () => number;
  readonly decoderCalls: Platform[];
  readonly decoderInputs: unknown[];
  readonly configCalls: Platform[];
}

function defaultDecode(): DirectCredentialDecode {
  return {
    plaintext: bodyBytes({ access_token: "stored-token" }),
    payloadSchemaVersion: 1,
    expiresAt: null,
    target: { label: "stored-target", source: "user" },
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const fake = createSnapshotFake();
  const strategy = createStrategySpy();
  const cipher = createCipherSpy(createTestCipher());
  const reads: Platform[] = [];
  const mutations: SlotMutation[] = [];
  const decoderCalls: Platform[] = [];
  const decoderInputs: unknown[] = [];
  const configCalls: Platform[] = [];
  let readFailure: Error | null = null;
  let nextSnapshot: unknown = null;
  let cipherLookups = 0;
  const envValues = options.envValues ?? { X_API_KEY: "env-app-key" };
  const bindingId = options.bindingId ?? "bind-new-1";

  const store: CredentialStore = {
    ...fake.credentials,
    async readSlot(input) {
      reads.push(input.platform);
      if (options.beforeRead !== undefined) {
        await options.beforeRead();
      }
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
      return fake.credentials.readSlot(input);
    },
    async compareAndSetSlot(input) {
      mutations.push(input);
      if (options.beforeCompareAndSet !== undefined) {
        await options.beforeCompareAndSet(input);
      }
      const result = await fake.credentials.compareAndSetSlot(input);
      if (options.afterCompareAndSet !== undefined) {
        options.afterCompareAndSet(input);
      }
      return result;
    },
  };

  const registry: PlatformStrategyRegistry = {
    platforms: ["x", "linkedin", "threads"],
    strategyFor(platform: Platform): PublisherStrategy {
      if (platform !== "x" && platform !== "linkedin" && platform !== "threads") {
        throw new Error("no installed strategy");
      }
      return strategy.strategy;
    },
  };

  const decode: DirectCredentialDecoder =
    options.decode ??
    ((platform: Platform, input: unknown): DirectCredentialDecode => {
      decoderCalls.push(platform);
      decoderInputs.push(input);
      return defaultDecode();
    });

  const deps: DirectCredentialDependencies = {
    credentials: store,
    getCipher:
      options.getCipher ??
      (() => {
        cipherLookups += 1;
        return cipher.cipher;
      }),
    strategies: registry,
    configFor: (platform: Platform): PlatformConfigView => {
      configCalls.push(platform);
      return { platform, values: envValues, publicUrl: null };
    },
    clock: { now: () => FIXTURE_NOW },
    bindingIds: () => bindingId,
    decodeDirectCredential: decode,
  };

  const storeSpy: StoreSpy = {
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

  return {
    fake,
    store: storeSpy,
    strategy,
    cipher,
    deps,
    cipherLookups: () => cipherLookups,
    decoderCalls,
    decoderInputs,
    configCalls,
  };
}

async function seedActiveSlot(
  harness: Harness,
  platform: Platform,
  options: { readonly payloadRevision?: number; readonly envelope?: EncryptedCredential } = {},
): Promise<void> {
  const payloadRevision = options.payloadRevision ?? 1;
  const envelope =
    options.envelope ??
    (await createTestCipher().encrypt(bodyBytes({ access_token: "seeded-token" }), {
      purpose: "active_slot",
      recordId: platform,
      platform,
      payloadSchemaVersion: 1,
      payloadRevision,
    }));
  const result = await harness.fake.credentials.compareAndSetSlot({
    platform,
    expectedRevision: 0,
    now: FIXTURE_NOW,
    change: {
      kind: "set",
      bindingId: "bind-seeded",
      envelope,
      payloadRevision,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: null,
    },
  });
  expect(result.kind).toBe("applied");
}

async function removeTimes(harness: Harness, platform: Platform, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    const current = await harness.fake.credentials.readSlot({ platform });
    const result = await harness.fake.credentials.compareAndSetSlot({
      platform,
      expectedRevision: current.revision,
      now: FIXTURE_NOW,
      change: { kind: "remove" },
    });
    expect(result.kind).toBe("applied");
  }
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

function activeContextFor(platform: Platform, payloadRevision: number): CipherContext {
  return {
    purpose: "active_slot",
    recordId: platform,
    platform,
    payloadSchemaVersion: 1,
    payloadRevision,
  };
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

function setInput(
  platform: Platform,
  credential: unknown,
  expectedRevision?: number | null,
): { readonly platform: Platform; readonly credential: unknown; readonly expectedRevision?: number | null } {
  return expectedRevision === undefined
    ? { platform, credential }
    : { platform, credential, expectedRevision };
}

describe("setDirectCredential — one guarded write", () => {
  it("stores a complete group with the active-slot context", async () => {
    const harness = createHarness();
    const credential = { access_token: "stored-token" };

    const receipt = await setDirectCredential(setInput("x", credential), harness.deps);

    expect(receipt).toEqual({
      platform: "x",
      action: "stored",
      revision: 1,
      configured: true,
      readiness: "ready",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt).sort()).toEqual(
      ["action", "configured", "platform", "readiness", "revision"].sort(),
    );
    expect(harness.cipher.encryptContexts).toEqual([activeContextFor("x", 1)]);
    expect(harness.store.mutations).toHaveLength(1);
    const mutation = harness.store.mutations[0];
    expect(mutation?.expectedRevision).toBe(0);
    expect(mutation?.now).toBe(FIXTURE_NOW);
    expect(mutation?.change).toMatchObject({
      kind: "set",
      bindingId: "bind-new-1",
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: { label: "stored-target", source: "user" },
    });
    expect(harness.decoderCalls).toEqual(["x"]);
    expect(harness.decoderInputs).toEqual([credential]);
  });

  it("uses the platform value as the AAD record id for x and linkedin", async () => {
    for (const platform of ["x", "linkedin"] as const) {
      const harness = createHarness();

      await setDirectCredential(setInput(platform, { access_token: "token" }), harness.deps);

      expect(harness.cipher.encryptContexts).toEqual([
        {
          purpose: "active_slot",
          recordId: platform,
          platform,
          payloadSchemaVersion: 1,
          payloadRevision: 1,
        },
      ]);
    }
  });

  it("derives the next generation from payloadRevision and revision", async () => {
    const fresh = createHarness();
    await setDirectCredential(setInput("x", { access_token: "token" }), fresh.deps);
    expect(fresh.store.mutations[0]?.change).toMatchObject({ payloadRevision: 1 });

    const afterRemove = createHarness();
    await removeTimes(afterRemove, "x", 5);
    await setDirectCredential(setInput("x", { access_token: "token" }), afterRemove.deps);
    // revision 5 with no payload: max(0, 5) + 1 = 6
    expect(afterRemove.store.mutations[0]?.change).toMatchObject({ payloadRevision: 6 });

    const higherPayload = createHarness();
    const base = await higherPayload.fake.credentials.readSlot({ platform: "x" });
    expect(base.revision).toBe(0);
    await higherPayload.fake.credentials.compareAndSetSlot({
      platform: "x",
      expectedRevision: 0,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-seeded",
        envelope: await createTestCipher().encrypt(bodyBytes({ access_token: "seeded" }), {
          purpose: "active_slot",
          recordId: "x",
          platform: "x",
          payloadSchemaVersion: 1,
          payloadRevision: 9,
        }),
        payloadRevision: 9,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });
    await removeTimes(higherPayload, "x", 1);
    await higherPayload.fake.credentials.compareAndSetSlot({
      platform: "x",
      expectedRevision: 2,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-seeded-2",
        envelope: await createTestCipher().encrypt(bodyBytes({ access_token: "seeded-2" }), {
          purpose: "active_slot",
          recordId: "x",
          platform: "x",
          payloadSchemaVersion: 1,
          payloadRevision: 9,
        }),
        payloadRevision: 9,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });
    await setDirectCredential(setInput("x", { access_token: "token" }), higherPayload.deps);
    // revision 3 with payloadRevision 9: max(9, 3) + 1 = 10
    expect(higherPayload.store.mutations[0]?.change).toMatchObject({ payloadRevision: 10 });
  });

  it("performs zero encryption and zero writes on a revision mismatch", async () => {
    const harness = createHarness();
    const before = harness.fake.snapshot().slots;

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }, 7), harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.cipher.encryptContexts).toEqual([]);
    expect(harness.store.mutations).toEqual([]);
    expect(harness.fake.snapshot().slots).toEqual(before);
  });

  it("uses the read revision when the caller omits expectedRevision", async () => {
    const harness = createHarness();
    await removeTimes(harness, "x", 2);

    const receipt = await setDirectCredential(setInput("x", { access_token: "token" }), harness.deps);

    expect(receipt.action).toBe("stored");
    expect(receipt.revision).toBe(3);
    expect(harness.store.mutations[0]?.expectedRevision).toBe(2);
  });

  it("rejects an uninstalled platform with zero store contact", async () => {
    const harness = createHarness();

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("nostr", { access_token: "token" }), harness.deps),
    );

    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.reason).toBe("platform");
    expect(harness.store.reads).toEqual([]);
    expect(harness.cipher.encryptContexts).toEqual([]);
  });

  it("rejects malformed revisions with zero store contact", async () => {
    for (const expectedRevision of [-1, 1.5, Number.NaN, "3" as unknown as number]) {
      const harness = createHarness();
      const failure = await expectAuthFailure(
        setDirectCredential(setInput("x", { access_token: "token" }, expectedRevision), harness.deps),
      );
      expect(failure.code).toBe("INVALID_REQUEST");
      expect(failure.reason).toBe("expected_revision");
      expect(harness.store.reads).toEqual([]);
      expect(harness.cipher.encryptContexts).toEqual([]);
    }
  });

  it("never lets a decoder failure escape, even with hostiles", async () => {
    const harness = createHarness({
      decode: () => {
        throw new Error("SENTINEL_DECODER_FAILURE");
      },
    });

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }), harness.deps),
    );

    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.reason).toBe("credential_body");
    expect(failure.message).not.toContain("SENTINEL_DECODER_FAILURE");
    expect(harness.store.reads).toEqual([]);
    expect(harness.cipher.encryptContexts).toEqual([]);
  });

  it("rejects malformed decoder output before encrypting", async () => {
    const results: readonly DirectCredentialDecode[] = [
      { ...defaultDecode(), payloadSchemaVersion: 2 as unknown as 1 },
      { ...defaultDecode(), plaintext: "not-bytes" as unknown as Uint8Array },
      { ...defaultDecode(), plaintext: new Uint8Array(0) },
      { ...defaultDecode(), expiresAt: "2026-09-23T00:00:00Z" },
      { ...defaultDecode(), expiresAt: "not-an-instant" },
      { ...defaultDecode(), target: { label: "bad\u0000label", source: "user" } },
      { ...defaultDecode(), target: { label: "", source: "user" } },
      { ...defaultDecode(), target: { label: "label", source: "system" as unknown as "user" } },
    ];
    for (const result of results) {
      const harness = createHarness({ decode: () => result });
      const failure = await expectAuthFailure(
        setDirectCredential(setInput("x", { access_token: "token" }), harness.deps),
      );
      expect(failure.code).toBe("INVALID_REQUEST");
      expect(failure.reason).toBe("credential_body");
      expect(harness.cipher.encryptContexts).toEqual([]);
      expect(harness.store.mutations).toEqual([]);
    }
  });

  it("checks the generation bound before encrypting", async () => {
    const harness = createHarness();
    harness.store.returnNextSnapshot({
      ...emptySnapshot("x"),
      status: "tombstone",
      revision: Number.MAX_SAFE_INTEGER,
    });

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }), harness.deps),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("payload_generation_overflow");
    expect(harness.cipher.encryptContexts).toEqual([]);
    expect(harness.store.mutations).toEqual([]);
  });

  it("issues one mutation and never retries a committed-but-lost write", async () => {
    const harness = createHarness({
      afterCompareAndSet: () => {
        throw new StoreUnavailable("SENTINEL_LOST_ACK");
      },
    });

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }), harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_LOST_ACK");
    expect(harness.store.mutations).toHaveLength(1);
    // The store did commit, which is exactly why the use case must not retry.
    const slot = await harness.fake.credentials.readSlot({ platform: "x" });
    expect(slot.status).toBe("active");
    expect(slot.revision).toBe(1);
  });

  it("conflicts when the slot moved between the read and the write", async () => {
    const harness = createHarness({
      beforeCompareAndSet: async (input) => {
        await harness.fake.credentials.compareAndSetSlot({
          platform: input.platform,
          expectedRevision: input.expectedRevision,
          now: FIXTURE_NOW,
          change: { kind: "remove" },
        });
      },
    });

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }), harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.store.mutations).toHaveLength(1);
    const slot = await harness.fake.credentials.readSlot({ platform: "x" });
    expect(slot.status).toBe("tombstone");
    expect(slot.revision).toBe(1);
  });

  it("reports a store failure as a controlled error with one attempt", async () => {
    const harness = createHarness();
    const failing: CredentialStore = {
      ...harness.deps.credentials,
      async compareAndSetSlot() {
        throw new StoreUnavailable("SENTINEL_STORE_WRITE");
      },
    };

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }), {
        ...harness.deps,
        credentials: failing,
      }),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_STORE_WRITE");
  });

  it("keeps caller mutation during the read out of the stored payload", async () => {
    const target = { label: "caller-target", source: "user" as const };
    const decoded: DirectCredentialDecode = {
      plaintext: bodyBytes({ access_token: "original-token" }),
      payloadSchemaVersion: 1,
      expiresAt: null,
      target,
    };
    const original = new Uint8Array(decoded.plaintext);
    const gateControl: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      gateControl.release = resolve;
    });
    const harness = createHarness({
      decode: () => decoded,
      beforeRead: async () => {
        await gate;
      },
    });

    const pending = setDirectCredential(setInput("x", { access_token: "token" }), harness.deps);
    decoded.plaintext.fill(0);
    target.label = "mutated-target";
    gateControl.release?.();
    const receipt = await pending;

    const mutation = harness.store.mutations[0];
    const change = mutation?.change as Extract<SlotChange, { kind: "set" }>;
    const expectedEnvelope = await createTestCipher().encrypt(original, activeContextFor("x", 1));
    expect(change.envelope).toEqual(expectedEnvelope);
    expect(change.target).toEqual({ label: "caller-target", source: "user" });
    expect(receipt).toEqual({
      platform: "x",
      action: "stored",
      revision: 1,
      configured: true,
      readiness: "ready",
    });
  });

  it("validates the applied revision before projecting a receipt", async () => {
    const harness = createHarness();
    const broken: CredentialStore = {
      ...harness.deps.credentials,
      async compareAndSetSlot() {
        return { kind: "applied", revision: 0 };
      },
    };

    const failure = await expectAuthFailure(
      setDirectCredential(setInput("x", { access_token: "token" }), {
        ...harness.deps,
        credentials: broken,
      }),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("unexpected_result");
  });

  it("stores a complete group whose runtime app configuration is missing", async () => {
    const harness = createHarness({ envValues: {} });

    const receipt = await setDirectCredential(setInput("x", { access_token: "token" }), harness.deps);

    expect(receipt).toEqual({
      platform: "x",
      action: "stored",
      revision: 1,
      configured: false,
      readiness: "needs_configuration",
    });
    const slot = await harness.fake.credentials.readSlot({ platform: "x" });
    expect(slot.status).toBe("active");
    expect(slot.revision).toBe(1);
  });
});

describe("removeDirectCredential", () => {
  it("fences an unreadable active slot with an explicit revision and no key", async () => {
    const harness = createHarness();
    await seedActiveSlot(harness, "x");

    const receipt = await removeDirectCredential({ platform: "x", expectedRevision: 1 }, harness.deps);

    expect(receipt).toEqual({
      platform: "x",
      action: "removed",
      revision: 2,
      configured: true,
      readiness: "ready",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(harness.store.reads).toEqual([]);
    expect(harness.cipherLookups()).toBe(0);
    expect(harness.cipher.decryptContexts).toEqual([]);
    expect(harness.cipher.encryptContexts).toEqual([]);
    expect(harness.store.mutations).toHaveLength(1);
    expect(harness.store.mutations[0]?.expectedRevision).toBe(1);
    expect(harness.store.mutations[0]?.change).toEqual({ kind: "remove" });
  });

  it("uses the read revision once when the caller omits expectedRevision", async () => {
    const harness = createHarness();
    await removeTimes(harness, "x", 2);

    const receipt = await removeDirectCredential({ platform: "x" }, harness.deps);

    expect(receipt.revision).toBe(3);
    expect(harness.store.reads).toEqual(["x"]);
    expect(harness.store.mutations).toHaveLength(1);
    expect(harness.store.mutations[0]?.expectedRevision).toBe(2);
    expect(harness.cipherLookups()).toBe(0);
  });

  it("reports the resulting Env readiness instead of claiming unconfigured", async () => {
    const readyHarness = createHarness();
    const ready = await removeDirectCredential({ platform: "x", expectedRevision: 0 }, readyHarness.deps);
    expect(ready.configured).toBe(true);
    expect(ready.readiness).toBe("ready");

    const emptyHarness = createHarness({ envValues: {} });
    const unconfigured = await removeDirectCredential(
      { platform: "x", expectedRevision: 0 },
      emptyHarness.deps,
    );
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.readiness).toBe("missing_credentials");
    expect(unconfigured.revision).toBe(1);
  });

  it("advances the revision on every repeated removal", async () => {
    const harness = createHarness();

    const first = await removeDirectCredential({ platform: "x" }, harness.deps);
    const second = await removeDirectCredential(
      { platform: "x", expectedRevision: first.revision },
      harness.deps,
    );
    const third = await removeDirectCredential({ platform: "x" }, harness.deps);

    expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
    const slot = await harness.fake.credentials.readSlot({ platform: "x" });
    expect(slot.status).toBe("tombstone");
    expect(slot.revision).toBe(3);
  });

  it("conflicts on a stale explicit revision with a single attempt", async () => {
    const harness = createHarness();
    await seedActiveSlot(harness, "x");
    const before = await harness.fake.credentials.readSlot({ platform: "x" });

    const failure = await expectAuthFailure(
      removeDirectCredential({ platform: "x", expectedRevision: 9 }, harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.store.reads).toEqual([]);
    expect(harness.store.mutations).toHaveLength(1);
    expect(await harness.fake.credentials.readSlot({ platform: "x" })).toEqual(before);
  });

  it("refuses an unadvanceable revision before any write", async () => {
    const harness = createHarness();

    const failure = await expectAuthFailure(
      removeDirectCredential(
        { platform: "x", expectedRevision: Number.MAX_SAFE_INTEGER },
        harness.deps,
      ),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("payload_generation_overflow");
    expect(harness.store.reads).toEqual([]);
    expect(harness.store.mutations).toEqual([]);
  });

  it("refuses an unadvanceable revision discovered by the compatibility read", async () => {
    const harness = createHarness();
    harness.store.returnNextSnapshot({
      ...emptySnapshot("x"),
      status: "tombstone",
      revision: Number.MAX_SAFE_INTEGER,
    });

    const failure = await expectAuthFailure(removeDirectCredential({ platform: "x" }, harness.deps));

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("payload_generation_overflow");
    expect(harness.store.mutations).toEqual([]);
  });

  it("returns a controlled error when the compatibility read fails", async () => {
    const harness = createHarness();
    harness.store.failNextRead(new StoreUnavailable("SENTINEL_REMOVE_READ"));

    const failure = await expectAuthFailure(removeDirectCredential({ platform: "x" }, harness.deps));

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_REMOVE_READ");
    expect(harness.store.mutations).toEqual([]);
  });

  it("never lets hostile snapshot getters escape a removal", async () => {
    const harness = createHarness();
    const snapshot = emptySnapshot("x");
    Object.defineProperty(snapshot, "revision", {
      enumerable: true,
      get() {
        throw new Error("SENTINEL_REMOVE_GETTER");
      },
    });
    harness.store.returnNextSnapshot(snapshot);

    const failure = await expectAuthFailure(removeDirectCredential({ platform: "x" }, harness.deps));

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("corrupt_record");
    expect(failure.message).not.toContain("SENTINEL_REMOVE_GETTER");
    expect(harness.store.mutations).toEqual([]);
  });

  it("issues one mutation and never retries a committed-but-lost removal", async () => {
    const harness = createHarness({
      afterCompareAndSet: () => {
        throw new StoreUnavailable("SENTINEL_REMOVE_LOST_ACK");
      },
    });

    const failure = await expectAuthFailure(
      removeDirectCredential({ platform: "x", expectedRevision: 0 }, harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(harness.store.mutations).toHaveLength(1);
    const slot = await harness.fake.credentials.readSlot({ platform: "x" });
    expect(slot.status).toBe("tombstone");
    expect(slot.revision).toBe(1);
  });

  it("validates the applied revision before projecting a removal receipt", async () => {
    const harness = createHarness();
    const broken: CredentialStore = {
      ...harness.deps.credentials,
      async compareAndSetSlot() {
        return { kind: "applied", revision: Number.MAX_SAFE_INTEGER + 1 };
      },
    };

    const failure = await expectAuthFailure(
      removeDirectCredential(
        { platform: "x", expectedRevision: 0 },
        { ...harness.deps, credentials: broken },
      ),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("unexpected_result");
  });

  it("rejects malformed removal input with zero store contact", async () => {
    for (const expectedRevision of [-1, 2.5, "1" as unknown as number]) {
      const harness = createHarness();
      const failure = await expectAuthFailure(
        removeDirectCredential({ platform: "x", expectedRevision }, harness.deps),
      );
      expect(failure.code).toBe("INVALID_REQUEST");
      expect(failure.reason).toBe("expected_revision");
      expect(harness.store.reads).toEqual([]);
      expect(harness.store.mutations).toEqual([]);
    }
  });

  it("removes a legacy slot for a platform without an installed strategy", async () => {
    const harness = createHarness();

    const receipt = await removeDirectCredential({ platform: "nostr", expectedRevision: 0 }, harness.deps);

    expect(receipt.action).toBe("removed");
    expect(receipt.revision).toBe(1);
    expect(receipt.configured).toBe(false);
    expect(receipt.readiness).toBe("unavailable");
    expect(harness.store.mutations).toHaveLength(1);
  });

  it("conflicts when a concurrent removal wins the same revision", async () => {
    const harness = createHarness({
      beforeCompareAndSet: async (input) => {
        await harness.fake.credentials.compareAndSetSlot({
          platform: input.platform,
          expectedRevision: input.expectedRevision,
          now: FIXTURE_NOW,
          change: { kind: "remove" },
        });
      },
    });

    const failure = await expectAuthFailure(
      removeDirectCredential({ platform: "x" }, harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.store.mutations).toHaveLength(1);
    const slot = await harness.fake.credentials.readSlot({ platform: "x" });
    expect(slot.revision).toBe(1);
  });
});
