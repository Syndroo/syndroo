/**
 * Lazy runtime dependency composition — native workerd conformance.
 *
 * Runs only under `test/runtime-dependencies-v050.vitest.config.ts`, which
 * fails closed on any outbound request. The main Worker suite is deliberately
 * not used here: it has no global outbound isolation.
 *
 * The slice is proven in composition order: construction never validates keys
 * or touches a port, status/Env-path preparation stays available without keys,
 * a selected unreadable D1 slot is blocked without an Env fallback, new writes
 * and signing fail closed before any store effect, and valid keys drive the
 * real AES-256-GCM cipher and HMAC signer.
 */

import { describe, expect, it } from "vitest";

import {
  AuthUseCaseError,
  CipherUnavailableError,
  PublishingUseCaseError,
  assertProductionCipher,
  completeOAuthOperation,
  encodeBindingMaterial,
  encodeOAuthCandidate,
  createPost,
  removeDirectCredential,
  setDirectCredential,
  type CredentialCipher,
  type CredentialStore,
  type CompleteReceiptRecord,
} from "@syndroo/application";
import { createSnapshotFake, FIXTURE_NOW, instant } from "@syndroo/application/testing";

import {
  decodeDirectCredential,
} from "../src/composition/platform-credential-decoders.js";
import { platformStrategyRegistry } from "../src/composition/platform-strategies.js";
import { createOAuthDriverResolver } from "../src/composition/oauth-drivers.js";
import {
  BINDING_KEY_SETTING,
  CREDENTIAL_KEY_ID_SETTING,
  CREDENTIAL_KEY_SETTING,
  INSTANCE_CONFIGURATION_NAMES,
  PUBLIC_URL_SETTING,
  createRuntimeDependencies,
  type RuntimeDependencies,
} from "../src/composition/runtime-dependencies.js";
import {
  OTHER_CREDENTIAL_KEY,
  SENTINEL_SECRET,
  VALID_BINDING_KEY,
  VALID_CREDENTIAL_KEY,
  VALID_KEY_ID,
  instanceConfiguration,
} from "./support/runtime-dependencies-v050-fixtures.js";

interface CountingCredentials {
  readonly credentials: CredentialStore;
  readonly calls: string[];
  readonly counts: {
    readSlot: number;
    compareAndSetSlot: number;
    createAuthOperation: number;
    claimOAuthCallback: number;
    saveCandidate: number;
    activateCandidate: number;
  };
}

/** Counts port calls only; the fake still owns every semantic guard. */
function countingCredentials(fake: ReturnType<typeof createSnapshotFake>): CountingCredentials {
  const calls: string[] = [];
  const counts = {
    readSlot: 0,
    compareAndSetSlot: 0,
    createAuthOperation: 0,
    claimOAuthCallback: 0,
    saveCandidate: 0,
    activateCandidate: 0,
  };
  const record = (name: keyof CountingCredentials["counts"]): void => {
    counts[name] += 1;
    calls.push(name);
  };
  return {
    calls,
    counts,
    credentials: {
      ...fake.credentials,
      async readSlot(input): Promise<Awaited<ReturnType<CredentialStore["readSlot"]>>> {
        record("readSlot");
        return fake.credentials.readSlot(input);
      },
      async compareAndSetSlot(input): Promise<Awaited<ReturnType<CredentialStore["compareAndSetSlot"]>>> {
        record("compareAndSetSlot");
        return fake.credentials.compareAndSetSlot(input);
      },
      async createAuthOperation(input): Promise<void> {
        record("createAuthOperation");
        return fake.credentials.createAuthOperation(input);
      },
      async claimOAuthCallback(input) {
        record("claimOAuthCallback");
        return fake.credentials.claimOAuthCallback(input);
      },
      async saveCandidate(input) {
        record("saveCandidate");
        return fake.credentials.saveCandidate(input);
      },
      async activateCandidate(input) {
        record("activateCandidate");
        return fake.credentials.activateCandidate(input);
      },
    },
  };
}

function composition(
  values: Readonly<Record<string, string | undefined>>,
  fake: ReturnType<typeof createSnapshotFake>,
): { readonly deps: RuntimeDependencies; readonly counts: CountingCredentials } {
  const counts = countingCredentials(fake);
  return {
    counts,
    deps: createRuntimeDependencies({ credentials: counts.credentials, values }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? JSON.stringify({ name: error.name, message: error.message, stack: error.stack })
    : String(error);
}

const SLOT_CONTEXT = Object.freeze({
  purpose: "active_slot" as const,
  recordId: "bluesky",
  platform: "bluesky" as const,
  payloadSchemaVersion: 1,
  payloadRevision: 1,
});

async function writeActiveSlot(
  fake: ReturnType<typeof createSnapshotFake>,
  cipher: CredentialCipher,
): Promise<void> {
  // Canonical D1 payload for the bluesky field group: sorted keys, plain JSON.
  const payload = new TextEncoder().encode(
    JSON.stringify({
      host: "bsky.social",
      identifier: "test.invalid",
      password: "fixture-password",
    }),
  );
  const envelope = await cipher.encrypt(payload, SLOT_CONTEXT);
  const result = await fake.credentials.compareAndSetSlot({
    platform: "bluesky",
    expectedRevision: 0,
    now: FIXTURE_NOW,
    change: {
      kind: "set",
      bindingId: "bind-slot-1",
      envelope,
      payloadRevision: SLOT_CONTEXT.payloadRevision,
      payloadSchemaVersion: SLOT_CONTEXT.payloadSchemaVersion,
      expiresAt: null,
      target: null,
    },
  });
  expect(result.kind).toBe("applied");
}

describe("runtime dependency construction", () => {
  it("constructs without keys and touches no port", async () => {
    const fake = createSnapshotFake();
    const before = fake.snapshot();
    const { deps, counts } = composition({}, fake);

    expect(counts.calls).toEqual([]);
    expect(fake.snapshot()).toEqual(before);
    expect(deps.publicUrl).toBeNull();
    expect(deps.configuration).toEqual({});
    expect(Object.isFrozen(deps.configuration)).toBe(true);
    const readiness = deps.instanceReadiness();
    expect(readiness.publishingReady).toBe(false);
    expect(readiness.missingFields).toEqual([
      CREDENTIAL_KEY_SETTING,
      CREDENTIAL_KEY_ID_SETTING,
      BINDING_KEY_SETTING,
    ]);
    expect(Object.isFrozen(readiness)).toBe(true);
    expect(Object.isFrozen(readiness.missingFields)).toBe(true);
  });

  it("copies only allowlisted names, once, and never echoes unrelated secrets", async () => {
    const fake = createSnapshotFake();
    const values = instanceConfiguration();
    const { deps, counts } = composition(values, fake);

    expect(counts.calls).toEqual([]);
    expect(deps.configuration[CREDENTIAL_KEY_SETTING]).toBe(VALID_CREDENTIAL_KEY);
    expect(deps.configuration["X_API_KEY"]).toBe("fixture-x-key");
    expect(deps.configuration["LINKEDIN_CLIENT_SECRET"]).toBe("fixture-linkedin-client-secret");
    expect(deps.configuration["SYNDROO_API_KEY"]).toBeUndefined();
    expect(deps.configuration["UNRELATED_SECRET"]).toBeUndefined();
    expect(JSON.stringify(deps.configuration)).not.toContain(SENTINEL_SECRET);
    expect(deps.instanceReadiness().publishingReady).toBe(true);
    expect(deps.publicUrl).toBe("https://syndroo.test");

    // Mutating the caller's object afterwards cannot change the capture.
    values[CREDENTIAL_KEY_SETTING] = SENTINEL_SECRET;
    values["X_API_KEY"] = SENTINEL_SECRET;
    values[PUBLIC_URL_SETTING] = "http://not-https.invalid";
    expect(deps.instanceReadiness().publishingReady).toBe(true);
    expect(deps.configFor("x").values["X_API_KEY"]).toBe("fixture-x-key");
    expect(deps.configuration[CREDENTIAL_KEY_SETTING]).toBe(VALID_CREDENTIAL_KEY);
    expect(deps.publicUrl).toBe("https://syndroo.test");
    expect(JSON.stringify(deps.instanceReadiness())).not.toContain(SENTINEL_SECRET);
  });

  it("keeps the public URL out of publishing readiness", async () => {
    const fake = createSnapshotFake();
    const { deps } = composition(
      instanceConfiguration({ SYNDROO_PUBLIC_URL: "" }),
      fake,
    );
    expect(deps.publicUrl).toBeNull();
    expect(deps.instanceReadiness()).toEqual({
      publishingReady: true,
      missingFields: [],
    });
    // Connect needs the origin; the strategies still see a null public URL.
    expect(deps.configFor("bluesky").publicUrl).toBeNull();
  });
});

describe("runtime dependency laziness", () => {
  it("keeps the Env path available with absent or invalid keys and fails cipher use closed", async () => {
    const cases: readonly {
      readonly label: string;
      readonly values: Readonly<Record<string, string | undefined>>;
      readonly missing: readonly string[];
    }[] = [
      {
        label: "absent",
        values: instanceConfiguration({
          SYNDROO_CREDENTIAL_KEY: undefined,
          SYNDROO_CREDENTIAL_KEY_ID: undefined,
          SYNDROO_BINDING_KEY: undefined,
        }),
        missing: [CREDENTIAL_KEY_SETTING, CREDENTIAL_KEY_ID_SETTING, BINDING_KEY_SETTING],
      },
      {
        label: "malformed key",
        values: instanceConfiguration({ SYNDROO_CREDENTIAL_KEY: SENTINEL_SECRET }),
        missing: [CREDENTIAL_KEY_SETTING],
      },
      {
        label: "malformed key id",
        values: instanceConfiguration({ SYNDROO_CREDENTIAL_KEY_ID: "not a valid id" }),
        missing: [CREDENTIAL_KEY_ID_SETTING],
      },
    ];

    for (const entry of cases) {
      const fake = createSnapshotFake();
      const { deps, counts } = composition(entry.values, fake);
      const readiness = deps.instanceReadiness();
      expect(readiness.missingFields, entry.label).toEqual(entry.missing);
      expect(readiness.publishingReady, entry.label).toBe(false);
      expect(JSON.stringify(readiness), entry.label).not.toContain(SENTINEL_SECRET);

      // Status/admission/replay stay available: an empty slot uses the Env
      // group, which needs no cipher at all.
      const preparation = await deps.getPreparePublisher()("bluesky", FIXTURE_NOW);
      expect(preparation.kind, entry.label).toBe("ready");
      if (preparation.kind === "ready") {
        expect(preparation.prepared.credentialSource, entry.label).toBe("env");
      }
      expect(counts.calls, entry.label).toEqual(["readSlot"]);
      expect(counts.calls, entry.label).not.toContain("compareAndSetSlot");
      expect(fake.snapshot().slots, entry.label).toEqual([]);

      // New encryption and signing fail closed with fixed, value-free errors.
      let cipherError: unknown;
      try {
        await deps
          .getReadCipher()
          .encrypt(new TextEncoder().encode("payload"), SLOT_CONTEXT);
      } catch (error) {
        cipherError = error;
      }
      expect(cipherError, entry.label).toBeInstanceOf(CipherUnavailableError);
      expect(errorText(cipherError), entry.label).not.toContain(SENTINEL_SECRET);

      let signError: unknown;
      try {
        await deps.bindingSigner.sign(
          encodeBindingMaterial({
            platform: "bluesky",
            source: "env",
            fields: [["BLUESKY_IDENTIFIER", "test.invalid"]],
          }),
        );
      } catch (error) {
        signError = error;
      }
      expect(signError, entry.label).toBeDefined();
      expect(errorText(signError), entry.label).not.toContain(SENTINEL_SECRET);
    }
  });

  it("blocks an unreadable active slot and never falls back to Env", async () => {
    const fake = createSnapshotFake();
    // The stored slot is encrypted under a different credential key.
    const writer = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration({ SYNDROO_CREDENTIAL_KEY: OTHER_CREDENTIAL_KEY }),
    });
    await writeActiveSlot(fake, writer.getWriteCipher());

    const { deps, counts } = composition(instanceConfiguration(), fake);
    const blocked = await deps.getPreparePublisher()("bluesky", FIXTURE_NOW);
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind === "blocked") {
      // The accepted strategy owns the blocked reason; this slice only has to
      // keep the selected D1 group selected and never fall back to Env.
      expect([
        "missing_credentials",
        "needs_configuration",
        "expired",
        "reconnect_required",
        "unavailable",
        "invalid_configuration",
      ]).toContain(blocked.reason);
      expect(blocked.status.source).toBe("credential");
      expect(JSON.stringify(blocked)).not.toContain(SENTINEL_SECRET);
    }
    expect(counts.calls).toEqual(["readSlot"]);
    expect(counts.calls).not.toContain("compareAndSetSlot");

    // The instance holding the matching key reads the same slot.
    const owner = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration({ SYNDROO_CREDENTIAL_KEY: OTHER_CREDENTIAL_KEY }),
    });
    const ready = await owner.getPreparePublisher()("bluesky", FIXTURE_NOW);
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready") {
      expect(ready.prepared.credentialSource).toBe("credential");
      expect(ready.prepared.slotBindingId).toBe("bind-slot-1");
    }
  });

  it("removes through the accepted use case with no key and exactly one CAS", async () => {
    const fake = createSnapshotFake();
    const writer = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration(),
    });
    await writeActiveSlot(fake, writer.getWriteCipher());

    // No credential or binding key: removal must still work without a cipher.
    const { deps, counts } = composition(
      instanceConfiguration({
        SYNDROO_CREDENTIAL_KEY: undefined,
        SYNDROO_CREDENTIAL_KEY_ID: undefined,
        SYNDROO_BINDING_KEY: undefined,
      }),
      fake,
    );
    let cipherLookups = 0;
    const receipt = await removeDirectCredential(
      { platform: "bluesky", expectedRevision: 1 },
      {
        credentials: counts.credentials,
        getCipher: () => {
          cipherLookups += 1;
          return deps.getReadCipher();
        },
        strategies: platformStrategyRegistry,
        configFor: deps.configFor,
        clock: deps.clock,
        bindingIds: () => "bind-unused",
        decodeDirectCredential,
      },
    );

    expect(receipt.action).toBe("removed");
    expect(receipt.revision).toBe(2);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(counts.counts.readSlot).toBe(0);
    expect(counts.counts.compareAndSetSlot).toBe(1);
    expect(cipherLookups).toBe(0);

    // The tombstone selects the allowed Env group, not the removed D1 secrets.
    const preparation = await deps.getPreparePublisher()("bluesky", FIXTURE_NOW);
    expect(preparation.kind).toBe("ready");
    if (preparation.kind === "ready") {
      expect(preparation.prepared.credentialSource).toBe("env");
      expect(preparation.prepared.slotBindingId).toBeNull();
    }
  });

  it("fails an accepted direct set closed before any mutation", async () => {
    const fake = createSnapshotFake();
    const before = fake.snapshot();
    // No keys at all; Env publishing configuration is complete.
    const { deps, counts } = composition({}, fake);

    let caught: unknown;
    let cipherLookups = 0;
    await setDirectCredential(
      {
        platform: "x",
        credential: { access_token: "fixture-access", access_token_secret: "fixture-secret" },
        expectedRevision: 0,
      },
      {
        credentials: counts.credentials,
        getCipher: (): CredentialCipher => {
          cipherLookups += 1;
          return deps.getWriteCipher();
        },
        strategies: platformStrategyRegistry,
        configFor: deps.configFor,
        clock: deps.clock,
        bindingIds: () => "bind-unwritten",
        decodeDirectCredential,
      },
    ).catch((error: unknown) => {
      caught = error;
    });

    // A readiness failure is fixed and value-free, and no mutation or
    // encryption happened first. Reads are allowed (the set path may resolve
    // the slot and its status before the key check).
    expect(caught).toBeInstanceOf(AuthUseCaseError);
    expect(["INSTANCE_NOT_READY", "STORE_UNAVAILABLE"]).toContain(
      (caught as AuthUseCaseError).code,
    );
    expect(errorText(caught)).not.toContain(SENTINEL_SECRET);
    // A new write did look up the write cipher; it never reached a mutation.
    expect(cipherLookups).toBeGreaterThan(0);
    expect(counts.counts.compareAndSetSlot).toBe(0);
    expect(fake.snapshot()).toEqual(before);
    expect(fake.snapshot().slots).toEqual([]);
  });

  it("fails a new create closed before any write, enqueue or provider effect", async () => {
    const fake = createSnapshotFake();
    const writer = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration(),
    });
    // An active D1 group exists, so the Env fallback is not allowed.
    await writeActiveSlot(fake, writer.getWriteCipher());
    const before = fake.snapshot();

    const { deps, counts } = composition({}, fake);
    let queueSends = 0;
    let caught: unknown;
    await createPost(
      { content: "blocked create", platforms: ["bluesky"] },
      {
        publishing: fake.publishing,
        outbox: fake.outbox,
        queue: {
          async send(): Promise<void> {
            queueSends += 1;
          },
        },
        signer: deps.bindingSigner,
        prepare: deps.getPreparePublisher(),
        clock: deps.clock,
        ids: deps.publishingIds,
      },
      "key-blocked-create",
    ).catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(PublishingUseCaseError);
    expect((caught as PublishingUseCaseError).code).toBe("PUBLISHER_PREPARATION_BLOCKED");
    expect(errorText(caught)).not.toContain(SENTINEL_SECRET);
    expect(queueSends).toBe(0);
    expect(counts.counts.compareAndSetSlot).toBe(0);
    // No post, publication or job row was written for the blocked create.
    expect(fake.snapshot()).toEqual(before);
  });

  it("fails an Env-ready create at signing when only the binding key is missing", async () => {
    const fake = createSnapshotFake();
    const before = fake.snapshot();
    // Credential key, key id and every Env/app field are present; only the
    // independent binding key is absent.
    const { deps, counts } = composition(
      instanceConfiguration({ SYNDROO_BINDING_KEY: undefined }),
      fake,
    );
    expect(deps.instanceReadiness()).toEqual({
      publishingReady: false,
      missingFields: [BINDING_KEY_SETTING],
    });

    const prepare = deps.getPreparePublisher();
    let prepares = 0;
    let queueSends = 0;
    let caught: unknown;
    await createPost(
      { content: "binding gate", platforms: ["bluesky"] },
      {
        publishing: fake.publishing,
        outbox: fake.outbox,
        queue: {
          async send(): Promise<void> {
            queueSends += 1;
          },
        },
        // Delegating signer: the composition's own cached delegate is what fails.
        signer: deps.bindingSigner,
        prepare: async (platform, now) => {
          prepares += 1;
          return prepare(platform, now);
        },
        clock: deps.clock,
        ids: deps.publishingIds,
      },
      "key-binding-gate",
    ).catch((error: unknown) => {
      caught = error;
    });

    // Preparation reached the Env-ready publisher; the failure is the signing
    // gate, and nothing was written or enqueued.
    expect(prepares).toBe(1);
    expect(caught).toBeInstanceOf(PublishingUseCaseError);
    expect((caught as PublishingUseCaseError).code).toBe("INSTANCE_NOT_READY");
    expect(errorText(caught)).not.toContain(SENTINEL_SECRET);
    expect(queueSends).toBe(0);
    expect(counts.counts.compareAndSetSlot).toBe(0);
    expect(fake.snapshot()).toEqual(before);
  });

  it("reports a failed slot read as a controlled, sentinel-free failure", async () => {
    const fake = createSnapshotFake();
    const failing: CredentialStore = {
      ...fake.credentials,
      async readSlot(): Promise<never> {
        throw new Error(`storage exploded ${SENTINEL_SECRET}`);
      },
    };
    const deps = createRuntimeDependencies({
      credentials: failing,
      values: instanceConfiguration(),
    });

    let caught: unknown;
    await deps.getPreparePublisher()("bluesky", FIXTURE_NOW).catch((error: unknown) => {
      caught = error;
    });
    // A storage failure is never an absent slot and never an Env fallback.
    expect(caught).toBeInstanceOf(AuthUseCaseError);
    expect((caught as AuthUseCaseError).code).toBe("STORE_UNAVAILABLE");
    expect((caught as AuthUseCaseError).reason).toBe("store_unavailable");
    expect(errorText(caught)).not.toContain(SENTINEL_SECRET);
  });

  it("keeps accepted blocked-status semantics for a corrupt active slot", async () => {
    const fake = createSnapshotFake();
    const writer = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration({ SYNDROO_CREDENTIAL_KEY: OTHER_CREDENTIAL_KEY }),
    });
    const payload = new TextEncoder().encode(
      JSON.stringify({ blog: "fixture-blog", token: "fixture-token", token_secret: "fixture-secret" }),
    );
    const tumblrContext = Object.freeze({
      purpose: "active_slot" as const,
      recordId: "tumblr",
      platform: "tumblr" as const,
      payloadSchemaVersion: 1,
      payloadRevision: 1,
    });
    const result = await fake.credentials.compareAndSetSlot({
      platform: "tumblr",
      expectedRevision: 0,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-tumblr-1",
        envelope: await writer.getWriteCipher().encrypt(payload, tumblrContext),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });
    expect(result.kind).toBe("applied");

    // The instance cannot decrypt the selected slot: the accepted closure hands
    // the strategy a null plaintext, which reports its own blocked status.
    const { deps } = composition(instanceConfiguration(), fake);
    const blocked = await deps.getPreparePublisher()("tumblr", FIXTURE_NOW);
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind === "blocked") {
      // Accepted semantics: the D1 group is selected (never Env) and the
      // platform's own OAuth capability is preserved, not overwritten. Tumblr
      // keeps its Env app group beside the D1 user group, hence "mixed".
      expect(blocked.status.source).toBe("mixed");
      expect(blocked.status.oauthSupported).toBe(true);
      expect(blocked.status.revision).toBe(1);
      expect(JSON.stringify(blocked)).not.toContain(SENTINEL_SECRET);
    }
  });

  it("reads every allowlisted configuration name at most once", async () => {
    const fake = createSnapshotFake();
    const reads = new Map<string, number>();
    const values: Record<string, string> = {};
    for (const name of [...INSTANCE_CONFIGURATION_NAMES, "SYNDROO_API_KEY", "UNRELATED_SECRET"]) {
      Object.defineProperty(values, name, {
        enumerable: true,
        configurable: true,
        get(): string {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return name === "SYNDROO_BINDING_KEY" ? VALID_BINDING_KEY : "fixture-value";
        },
      });
    }

    const deps = createRuntimeDependencies({ credentials: fake.credentials, values });

    expect(reads.get("SYNDROO_API_KEY")).toBeUndefined();
    expect(reads.get("UNRELATED_SECRET")).toBeUndefined();
    for (const [name, count] of reads) {
      expect(count, name).toBeLessThanOrEqual(1);
    }
    expect(INSTANCE_CONFIGURATION_NAMES).toContain(CREDENTIAL_KEY_SETTING);
    expect(new Set(INSTANCE_CONFIGURATION_NAMES).size).toBe(INSTANCE_CONFIGURATION_NAMES.length);
    // Construction stays inert; later reads use the frozen copy, not the getters.
    expect(deps.configuration[CREDENTIAL_KEY_SETTING]).toBe("fixture-value");
    const before = new Map(reads);
    expect(deps.instanceReadiness().publishingReady).toBe(false);
    expect(reads).toEqual(before);
  });
});

describe("runtime dependency real adapters", () => {
  it("drives the real AES-256-GCM cipher and HMAC signer with valid keys", async () => {
    const fake = createSnapshotFake();
    const { deps } = composition(instanceConfiguration(), fake);
    expect(deps.instanceReadiness()).toEqual({ publishingReady: true, missingFields: [] });

    const read = deps.getReadCipher();
    const write = deps.getWriteCipher();
    // Successful adapter construction is cached, and the write path reuses the
    // one AES cipher after separately validating the binding key.
    expect(read).toBe(write);
    expect(deps.getReadCipher()).toBe(read);
    // The cached adapter is frozen at the composition boundary: a caller cannot
    // replace its methods through the returned object.
    expect(Object.isFrozen(read)).toBe(true);
    expect(() => {
      (read as unknown as { encrypt: unknown }).encrypt = "replaced";
    }).toThrow(TypeError);
    expect(typeof read.encrypt).toBe("function");
    expect(typeof read.decrypt).toBe("function");
    assertProductionCipher(write);
    expect(Object.isFrozen(deps.bindingSigner)).toBe(true);
    expect(() => {
      (deps.bindingSigner as unknown as { sign: unknown }).sign = "replaced";
    }).toThrow(TypeError);

    const payload = new TextEncoder().encode("round-trip payload");
    const envelope = await write.encrypt(payload, SLOT_CONTEXT);
    const back = await read.decrypt(envelope, SLOT_CONTEXT);
    expect([...back]).toEqual([...payload]);

    // A different trusted record identity fails authentication.
    let aadError: unknown;
    try {
      await read.decrypt(envelope, { ...SLOT_CONTEXT, recordId: "tumblr" });
    } catch (error) {
      aadError = error;
    }
    expect(aadError).toBeInstanceOf(CipherUnavailableError);

    const material = encodeBindingMaterial({
      platform: "bluesky",
      source: "env",
      fields: [
        ["slotBinding", null],
        ["BLUESKY_IDENTIFIER", "test.invalid"],
      ],
    });
    const first = await deps.bindingSigner.sign(material);
    const second = await deps.bindingSigner.sign(material);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(errorText(first)).not.toContain(SENTINEL_SECRET);
  });

  it("keeps the read cipher usable when only the binding key is missing", async () => {
    const fake = createSnapshotFake();
    const { deps } = composition(
      instanceConfiguration({ SYNDROO_BINDING_KEY: undefined }),
      fake,
    );
    expect(deps.instanceReadiness()).toEqual({
      publishingReady: false,
      missingFields: [BINDING_KEY_SETTING],
    });

    const cipher = deps.getReadCipher();
    const payload = new TextEncoder().encode("read-only payload");
    const envelope = await cipher.encrypt(payload, SLOT_CONTEXT);
    expect([...(await cipher.decrypt(envelope, SLOT_CONTEXT))]).toEqual([...payload]);

    expect(() => deps.getWriteCipher()).toThrow(/binding key/);
    await expect(
      deps.bindingSigner.sign(
        encodeBindingMaterial({
          platform: "bluesky",
          source: "env",
          fields: [["BLUESKY_IDENTIFIER", "test.invalid"]],
        }),
      ),
    ).rejects.toThrow(/binding key/);
  });

  it("replays an accepted create without consulting prepare, signing or the queue", async () => {
    const fake = createSnapshotFake();
    // A new create requires every key configuration, even on the Env path.
    const keys = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration(),
    });
    const prepare = keys.getPreparePublisher();
    let prepares = 0;
    let signs = 0;
    let sends = 0;
    const accepted = await createPost(
      { content: "replay fixture", platforms: ["bluesky"] },
      {
        publishing: fake.publishing,
        outbox: fake.outbox,
        queue: {
          async send(): Promise<void> {
            sends += 1;
          },
        },
        signer: {
          async sign(material): Promise<string> {
            signs += 1;
            return keys.bindingSigner.sign(material);
          },
        },
        prepare: async (platform, now) => {
          prepares += 1;
          return prepare(platform, now);
        },
        clock: keys.clock,
        ids: keys.publishingIds,
      },
      "key-create-replay",
    );
    expect(accepted.replayed).toBe(false);
    expect(prepares).toBe(1);
    expect(signs).toBe(1);
    expect(sends).toBe(1);

    // A replay is answered before preparation, signing or any configuration or
    // key check. The wrappers delegate to the absent-key composition, so any
    // consultation would count (and signing would fail), and no key is set.
    const { deps } = composition({}, fake);
    const replayPrepare = deps.getPreparePublisher();
    let replayPrepares = 0;
    let replaySigns = 0;
    let replaySends = 0;
    const replay = await createPost(
      { content: "replay fixture", platforms: ["bluesky"] },
      {
        publishing: fake.publishing,
        outbox: fake.outbox,
        queue: {
          async send(): Promise<void> {
            replaySends += 1;
          },
        },
        signer: {
          async sign(material): Promise<string> {
            replaySigns += 1;
            return deps.bindingSigner.sign(material);
          },
        },
        prepare: async (platform, now) => {
          replayPrepares += 1;
          return replayPrepare(platform, now);
        },
        clock: deps.clock,
        ids: deps.publishingIds,
      },
      "key-create-replay",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.postId).toBe(accepted.postId);
    expect(replayPrepares).toBe(0);
    expect(replaySigns).toBe(0);
    expect(replaySends).toBe(0);
    expect(sends).toBe(1);
    expect(deps.instanceReadiness().publishingReady).toBe(false);
  });

  it("replays a completed authorization without activating again or needing a key", async () => {
    const fake = createSnapshotFake();
    const keys = createRuntimeDependencies({
      credentials: fake.credentials,
      values: instanceConfiguration(),
    });
    const operationId = "op_replay_1";
    const callbackUrl = "https://syndroo.test/v1/auth/x/callback";
    const configBinding = "config-binding-1";
    const candidateRevision = 1;

    // Seed history with the same clock the replay observes, so the stored
    // operation is neither expired nor inconsistent with the fixture.
    const seededAt = keys.clock.now();
    await fake.credentials.createAuthOperation({
      operationId,
      platform: "x",
      now: seededAt,
      expectedRevision: 0,
      canonicalCallbackUrl: callbackUrl,
      startConfigBinding: configBinding,
      oauthState: "state_replay_1",
      requestToken: null,
      requestSecret: null,
      requestSecretPurpose: null,
      requestSecretRevision: null,
      expiresAt: instant(30 * 60_000, seededAt),
    });
    const claim = await fake.credentials.claimOAuthCallback({
      platform: "x",
      oauthState: "state_replay_1",
      requestToken: null,
      now: seededAt,
      currentConfigBinding: configBinding,
    });
    expect(claim.kind).toBe("claimed");
    const candidate = encodeOAuthCandidate({
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          access_token: "fixture-candidate-token",
          access_token_secret: "fixture-candidate-secret",
        }),
      ),
      expiresAt: null,
    });
    expect(candidate.kind).toBe("ok");
    if (candidate.kind !== "ok") {
      return;
    }
    const envelope = await keys.getWriteCipher().encrypt(candidate.bytes, {
      purpose: "oauth_candidate",
      recordId: operationId,
      platform: "x",
      payloadSchemaVersion: 1,
      payloadRevision: candidateRevision,
    });
    const saved = await fake.credentials.saveCandidate({
      operationId,
      platform: "x",
      now: seededAt,
      outcome: {
        kind: "candidate",
        phase: "awaiting_confirmation",
        candidateEnvelope: envelope,
        candidatePayloadRevision: candidateRevision,
        candidatePayloadSchemaVersion: 1,
        candidateTarget: null,
        missingFields: [],
      },
    });
    expect(saved.kind).toBe("applied");

    const counters = countingCredentials(fake);
    // Seed the completed receipt through the accepted activation transaction.
    const receipt: CompleteReceiptRecord = {
      platform: "x",
      operationId,
      stored: true,
      revision: 1,
      configured: true,
      readiness: "ready",
    };
    const activeEnvelope = await keys.getWriteCipher().encrypt(
      new TextEncoder().encode(
        JSON.stringify({
          access_token: "fixture-active-token",
          access_token_secret: "fixture-active-secret",
        }),
      ),
      {
        purpose: "active_slot",
        recordId: "x",
        platform: "x",
        payloadSchemaVersion: 1,
        payloadRevision: 1,
      },
    );
    const activated = await counters.credentials.activateCandidate({
      operationId,
      platform: "x",
      now: seededAt,
      expectedRevision: 0,
      bindingId: "bind-seeded",
      currentConfigBinding: configBinding,
      envelope: activeEnvelope,
      payloadRevision: 1,
      payloadSchemaVersion: 1,
      expiresAt: null,
      target: null,
      receipt,
    });
    expect(activated.kind).toBe("activated");

    // Replay through the accepted use case with an absent-key composition: the
    // delegating cipher/config/driver callbacks stay untouched and no second
    // activation may happen.
    const { deps } = composition({}, fake);
    const replayCounters = countingCredentials(fake);
    let cipherLookups = 0;
    let driverLookups = 0;
    let bindingCalls = 0;
    const realDrivers = createOAuthDriverResolver({
      values: deps.configuration,
      publicUrl: deps.publicUrl,
      signer: deps.bindingSigner,
    });
    const replay = await completeOAuthOperation(
      { platform: "x", operationId, expectedRevision: 7 },
      {
        credentials: replayCounters.credentials,
        getCipher: (): CredentialCipher => {
          cipherLookups += 1;
          return deps.getWriteCipher();
        },
        drivers: (platform) => {
          driverLookups += 1;
          return realDrivers(platform);
        },
        strategies: platformStrategyRegistry,
        configFor: deps.configFor,
        clock: deps.clock,
        bindingIds: () => {
          bindingCalls += 1;
          return "bind_never";
        },
      },
    );
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(replayCounters.counts.activateCandidate).toBe(0);
    expect(cipherLookups).toBe(0);
    expect(driverLookups).toBe(0);
    expect(bindingCalls).toBe(0);
    expect(errorText(JSON.stringify(replay))).not.toContain(SENTINEL_SECRET);
  });
});
