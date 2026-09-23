/**
 * Task T6c1 — portable OAuth callback tests.
 *
 * The callback is the only public path that can cause provider work, so every
 * case here pins the number of exchange attempts, the claim count and the fact
 * that the active credential slot is never touched.
 */
import { describe, expect, it } from "vitest";

import {
  StoreUnavailable,
  type CredentialCipher,
  type CredentialStore,
  type EncryptedCredential,
} from "../src/index.js";
import { AuthUseCaseError } from "../src/use-cases/auth-errors.js";
import {
  completeOAuthCallback,
  type OAuthCallbackDependencies,
  type OAuthCallbackInput,
} from "../src/use-cases/oauth-callback.js";
import { OAuthDriverError } from "../src/use-cases/oauth-driver.js";
import { readAuthOperationProjection } from "../src/use-cases/auth-operation.js";
import {
  OAUTH_NOW,
  OAUTH_PLATFORM,
  OAUTH_TTL_END,
  bodyBytes,
  createCipherSpy,
  createClock,
  createDriverSpy,
  createPrepareStub,
  createResolverSpy,
  createStoreSpy,
  seedOperation,
  readOperation,
} from "./oauth-test-support.js";
import { createTestCipher } from "../src/testing/index.js";

const CALLBACK_URL = "https://worker.example/v1/auth/x/callback";
const REQUEST_SECRET = new TextEncoder().encode("request-secret-1");

interface CallbackHarness {
  readonly deps: OAuthCallbackDependencies;
  readonly store: ReturnType<typeof createStoreSpy>;
  readonly driver: ReturnType<typeof createDriverSpy>;
  readonly cipher: ReturnType<typeof createCipherSpy>;
  readonly clock: ReturnType<typeof createClock>;
}

function createHarness(options: { readonly getCipher?: () => CredentialCipher } = {}): CallbackHarness {
  const store = createStoreSpy();
  const driver = createDriverSpy();
  const resolver = createResolverSpy({ [OAUTH_PLATFORM]: driver.driver });
  const cipher = createCipherSpy();
  const clock = createClock();
  const deps: OAuthCallbackDependencies = {
    credentials: store.store,
    getCipher: options.getCipher ?? (() => cipher.cipher),
    drivers: resolver.resolver,
    clock,
  };
  return { deps, store, driver, cipher, clock };
}

function callbackInput(overrides: Partial<OAuthCallbackInput> = {}): OAuthCallbackInput {
  return {
    platform: OAUTH_PLATFORM,
    state: "state-1",
    // OAuth1 success carries the original request token and a verifier; a `code`
    // would be a cross-protocol parameter and is rejected.
    requestToken: "request-token-1",
    verifier: "verifier-1",
    ...overrides,
  };
}

async function seedClaimable(
  harness: CallbackHarness,
  overrides: Partial<Parameters<typeof seedOperation>[1]> = {},
  cipher: CredentialCipher = createTestCipher(),
): Promise<EncryptedCredential> {
  const envelope = await cipher.encrypt(REQUEST_SECRET, {
    purpose: "oauth_request_secret",
    recordId: overrides.operationId ?? "op-1",
    platform: OAUTH_PLATFORM,
    payloadSchemaVersion: 1,
    payloadRevision: 1,
  });
  await seedOperation(harness.store, {
    requestSecret: envelope,
    requestSecretPurpose: "oauth_request_secret",
    requestSecretRevision: 1,
    ...overrides,
  });
  return envelope;
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

describe("completeOAuthCallback — winner only", () => {
  it("exchanges once with the decrypted request secret and stores the candidate", async () => {
    const harness = createHarness();
    await seedClaimable(harness);

    const outcome = await completeOAuthCallback(callbackInput(), harness.deps);

    expect(outcome).toEqual({
      platform: OAUTH_PLATFORM,
      operationId: "op-1",
      phase: "awaiting_confirmation",
      expiresAt: OAUTH_TTL_END,
      missingFields: [],
      target: { label: "provider-target", source: "provider" },
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(harness.store.counts.claimOAuthCallback).toBe(1);
    expect(harness.driver.exchanges).toHaveLength(1);
    expect(harness.driver.exchanges[0]?.requestSecret).toEqual(REQUEST_SECRET);
    expect(harness.driver.exchanges[0]?.callback.state).toBe("state-1");
    expect(harness.cipher.decryptContexts).toEqual([
      {
        purpose: "oauth_request_secret",
        recordId: "op-1",
        platform: OAUTH_PLATFORM,
        payloadSchemaVersion: 1,
        payloadRevision: 1,
      },
    ]);
    expect(harness.cipher.encryptContexts).toEqual([
      {
        purpose: "oauth_candidate",
        recordId: "op-1",
        platform: OAUTH_PLATFORM,
        payloadSchemaVersion: 1,
        payloadRevision: 1,
      },
    ]);
    const saved = harness.store.saved[0];
    expect(saved?.outcome.kind).toBe("candidate");
    expect(harness.store.counts.saveCandidate).toBe(1);
    // The callback never writes the active slot or activates a candidate.
    expect(harness.store.counts.compareAndSetSlot).toBe(0);
    expect(harness.store.counts.activateCandidate).toBe(0);

    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.phase).toBe("awaiting_confirmation");
    expect(stored?.requestSecret).toBeNull();
    expect(stored?.candidateEnvelope).not.toBeNull();
    expect(stored?.candidateTarget).toEqual({ label: "provider-target", source: "provider" });
  });

  it("marks a candidate that still needs explicit target configuration", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    harness.driver.setExchangeResult({
      plaintext: bodyBytes({ access_token: "exchanged-token" }),
      expiresAt: "2026-12-31T23:59:59.000Z",
      target: null,
      missingFields: ["author", "api_version"],
    });

    const outcome = await completeOAuthCallback(callbackInput(), harness.deps);

    expect(outcome.phase).toBe("needs_configuration");
    expect(outcome.missingFields).toEqual(["author", "api_version"]);
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.phase).toBe("needs_configuration");
    expect(stored?.missingFields).toEqual(["author", "api_version"]);
    expect(stored?.candidateEnvelope).not.toBeNull();
  });

  it("lets exactly one concurrent callback exchange", async () => {
    const harness = createHarness();
    await seedClaimable(harness);

    const results = await Promise.allSettled([
      completeOAuthCallback(callbackInput(), harness.deps),
      completeOAuthCallback(callbackInput(), harness.deps),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(harness.driver.exchanges).toHaveLength(1);
    expect(harness.store.counts.saveCandidate).toBe(1);
    const loser = (rejected[0] as PromiseRejectedResult).reason as AuthUseCaseError;
    expect(loser.code).toBe("AUTH_CONFLICT");
    expect(loser.reason).toBe("operation_phase");
  });
});

describe("completeOAuthCallback — claim outcomes", () => {
  it("exchanges nothing when the claim result is unknown", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    harness.store.fake.faults.inject({ oauthClaimResultUnknownOnce: true });

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(harness.driver.exchanges).toEqual([]);
    expect(harness.store.counts.saveCandidate).toBe(0);
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.phase).toBe("pending_callback");
  });

  it("does not replay an exchange after a committed claim with a lost acknowledgement", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    harness.store.fake.faults.inject({ oauthClaimCommittedUnknownOnce: true });

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );
    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(harness.driver.exchanges).toEqual([]);

    const repeat = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );
    expect(repeat.code).toBe("AUTH_CONFLICT");
    expect(repeat.reason).toBe("operation_phase");
    expect(harness.driver.exchanges).toEqual([]);
  });

  it("reports claim failures as fixed errors without exchanging", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    harness.store.failNextClaim(new StoreUnavailable("SENTINEL_CLAIM"));

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.message).not.toContain("SENTINEL_CLAIM");
    expect(harness.driver.exchanges).toEqual([]);
  });

  it("keeps an unknown state, platform or request token opaque or conflicting", async () => {
    const unknownState = createHarness();
    await seedClaimable(unknownState);
    const stateFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput({ state: "other-state" }), unknownState.deps),
    );
    expect(stateFailure.code).toBe("NOT_FOUND");
    expect(stateFailure.reason).toBe("operation_not_found");
    expect(unknownState.driver.exchanges).toEqual([]);

    const wrongToken = createHarness();
    await seedClaimable(wrongToken);
    const tokenFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput({ requestToken: "other-token" }), wrongToken.deps),
    );
    expect(tokenFailure.code).toBe("AUTH_CONFLICT");
    expect(tokenFailure.reason).toBe("request_token_mismatch");
    expect(wrongToken.driver.exchanges).toEqual([]);

    const otherPlatform = createHarness();
    await seedClaimable(otherPlatform);
    const threadsDriver = createDriverSpy({
      platform: "threads",
      canonicalCallbackUrl: "https://worker.example/v1/auth/threads/callback",
    });
    const deps: OAuthCallbackDependencies = {
      ...otherPlatform.deps,
      drivers: createResolverSpy({ threads: threadsDriver.driver }).resolver,
    };
    const platformFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput({ platform: "threads" }), deps),
    );
    expect(platformFailure.code).toBe("NOT_FOUND");
    expect(threadsDriver.exchanges).toEqual([]);
  });

  it("refuses a changed configuration binding or canonical callback", async () => {
    const changedConfig = createHarness();
    await seedClaimable(changedConfig, { startConfigBinding: "other-binding" });
    const configFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), changedConfig.deps),
    );
    expect(configFailure.code).toBe("AUTH_CONFLICT");
    expect(configFailure.reason).toBe("config_changed");
    expect(changedConfig.driver.exchanges).toEqual([]);

    const changedCallback = createHarness();
    await seedClaimable(changedCallback, { canonicalCallbackUrl: "https://other.example/cb" });
    const callbackFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), changedCallback.deps),
    );
    expect(callbackFailure.code).toBe("AUTH_CONFLICT");
    expect(callbackFailure.reason).toBe("config_changed");
    expect(changedCallback.driver.exchanges).toEqual([]);
    expect(changedCallback.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "CONFIG_CHANGED",
    });
    expect(callbackFailure.message).not.toContain(CALLBACK_URL);
  });
});

describe("completeOAuthCallback — denial, expiry and failures", () => {
  it("persists an explicit provider denial with zero exchange", async () => {
    const harness = createHarness();
    await seedClaimable(harness);

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput({ denied: true }), harness.deps),
    );

    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(failure.reason).toBe("provider_error");
    expect(harness.driver.exchanges).toEqual([]);
    expect(harness.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "PROVIDER_DENIED",
    });
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.phase).toBe("failed");
    expect(stored?.errorCode).toBe("PROVIDER_DENIED");
  });

  it("does not exchange when the claim consumed the last valid instant", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    const inner = createTestCipher();
    const deps: OAuthCallbackDependencies = {
      ...harness.deps,
      getCipher: () => ({
        kind: inner.kind,
        keyId: inner.keyId,
        encrypt: (payload, context) => inner.encrypt(payload, context),
        decrypt: async (envelope, context) => {
          harness.clock.set(OAUTH_TTL_END);
          return inner.decrypt(envelope, context);
        },
      }),
    };

    const failure = await expectAuthFailure(completeOAuthCallback(callbackInput(), deps));

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("operation_expired");
    expect(harness.driver.exchanges).toEqual([]);
    expect(harness.store.counts.saveCandidate).toBe(0);
  });

  it("rejects a late candidate without backdating a failure record", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    const original = harness.driver.driver.exchange.bind(harness.driver.driver);
    harness.driver.driver.exchange = async (input) => {
      const result = await original(input);
      harness.clock.set(OAUTH_TTL_END);
      return result;
    };

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("operation_expired");
    expect(harness.driver.exchanges).toHaveLength(1);
    expect(harness.store.counts.saveCandidate).toBe(0);
    const stored = await readOperation(harness.store, "op-1");
    expect(stored?.candidateEnvelope).toBeNull();
    expect(stored?.requestSecret).not.toBeNull();

    // A repeat callback never exchanges again, and the read projection is expired.
    await expectAuthFailure(completeOAuthCallback(callbackInput(), harness.deps));
    expect(harness.driver.exchanges).toHaveLength(1);
    const prepare = createPrepareStub();
    const projection = await readAuthOperationProjection(
      { platform: OAUTH_PLATFORM, operationId: "op-1" },
      { credentials: harness.store.store, prepare: prepare.prepare, clock: harness.clock },
    );
    expect(projection.phase).toBe("expired");
  });

  it("records a fixed failure when the request secret cannot be decrypted", async () => {
    const wrongKey = createHarness();
    await seedClaimable(wrongKey, {}, createTestCipher("other-key"));
    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), wrongKey.deps),
    );
    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("request_secret_unavailable");
    expect(wrongKey.driver.exchanges).toEqual([]);
    expect(wrongKey.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "DECRYPTION_FAILED",
    });

    const missingMetadata = createHarness();
    await seedClaimable(missingMetadata, {
      requestSecretPurpose: null,
      requestSecretRevision: null,
    });
    const other = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), missingMetadata.deps),
    );
    expect(other.reason).toBe("request_secret_unavailable");
    expect(missingMetadata.driver.exchanges).toEqual([]);
  });

  it("fixes a provider failure and never retries the exchange", async () => {
    const denied = createHarness();
    await seedClaimable(denied);
    denied.driver.failNextExchange(new OAuthDriverError("denied"));

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), denied.deps),
    );

    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(failure.reason).toBe("provider_error");
    expect(denied.driver.exchanges).toHaveLength(1);
    expect(denied.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "PROVIDER_DENIED",
    });

    const unavailable = createHarness();
    await seedClaimable(unavailable);
    unavailable.driver.failNextExchange(new Error("SENTINEL_PROVIDER_BODY"));

    const other = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), unavailable.deps),
    );

    expect(other.message).not.toContain("SENTINEL_PROVIDER_BODY");
    expect(unavailable.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "PROVIDER_FAILED",
    });
    expect(unavailable.driver.exchanges).toHaveLength(1);
  });

  it("rejects malformed exchange results and keeps a closed field allowlist", async () => {
    const results: readonly Record<string, unknown>[] = [
      { plaintext: "not-bytes", expiresAt: null, target: null, missingFields: [] },
      {
        plaintext: bodyBytes({ access_token: "t" }),
        expiresAt: "not-a-date",
        target: null,
        missingFields: [],
      },
      {
        plaintext: bodyBytes({ access_token: "t" }),
        expiresAt: null,
        target: { label: "bad\u0000label", source: "user" },
        missingFields: [],
      },
      {
        plaintext: bodyBytes({ access_token: "t" }),
        expiresAt: null,
        target: { label: "label", source: "system" },
        missingFields: [],
      },
      {
        plaintext: bodyBytes({ access_token: "t" }),
        expiresAt: null,
        target: null,
        missingFields: ["SECRET_UPPERCASE_TOKEN"],
      },
      {
        plaintext: bodyBytes({ access_token: "t" }),
        expiresAt: null,
        target: null,
        missingFields: ["author", "author"],
      },
      {
        plaintext: bodyBytes({ access_token: "t" }),
        expiresAt: null,
        target: null,
        missingFields: ["author", "blog", "api_version", "author"],
      },
    ];

    for (const [index, result] of results.entries()) {
      const harness = createHarness();
      await seedClaimable(harness);
      harness.driver.setExchangeResult(result as never);

      const failure = await expectAuthFailure(
        completeOAuthCallback(callbackInput(), harness.deps),
      );

      expect(failure.code, String(index)).toBe("PROVIDER_ERROR");
      expect(failure.reason, String(index)).toBe("invalid_driver_response");
      expect(harness.store.saved[0]?.outcome, String(index)).toEqual({
        kind: "failed",
        errorCode: "INVALID_RESPONSE",
      });
      expect(JSON.stringify(harness.store.saved[0]), String(index)).not.toContain(
        "SECRET_UPPERCASE_TOKEN",
      );
      const stored = await readOperation(harness.store, "op-1");
      expect(stored?.candidateEnvelope, String(index)).toBeNull();
    }
  });

  it("rejects a candidate above the cipher bound", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    harness.driver.setExchangeResult({
      plaintext: new Uint8Array(50 * 1024),
      expiresAt: null,
      target: null,
      missingFields: [],
    });

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );

    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(failure.reason).toBe("invalid_driver_response");
    expect(harness.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("never reports success when the candidate commit does not apply", async () => {
    const conflict = createHarness();
    await seedClaimable(conflict);
    const conflictingStore: CredentialStore = {
      ...conflict.store.store,
      async saveCandidate() {
        return { kind: "conflict", reason: "phase_mismatch" };
      },
    };
    const conflictFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), { ...conflict.deps, credentials: conflictingStore }),
    );
    expect(conflictFailure.code).toBe("AUTH_CONFLICT");
    expect(conflictFailure.reason).toBe("operation_phase");

    const replayed = createHarness();
    await seedClaimable(replayed);
    const replayingStore: CredentialStore = {
      ...replayed.store.store,
      async saveCandidate() {
        return { kind: "already_applied" };
      },
    };
    const replayFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), { ...replayed.deps, credentials: replayingStore }),
    );
    expect(replayFailure.code).toBe("AUTH_CONFLICT");
    expect(replayFailure.reason).toBe("unexpected_result");
  });

  it("reports a storage failure and a missing cipher without exchanging", async () => {
    const saveFailure = createHarness();
    await seedClaimable(saveFailure);
    saveFailure.store.failNextSave(new StoreUnavailable("SENTINEL_SAVE"));
    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), saveFailure.deps),
    );
    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.message).not.toContain("SENTINEL_SAVE");

    const noCipher = createHarness({
      getCipher: () => {
        throw new StoreUnavailable("SENTINEL_NO_CIPHER");
      },
    });
    await seedClaimable(noCipher);
    const cipherFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), noCipher.deps),
    );
    expect(cipherFailure.code).toBe("INSTANCE_NOT_READY");
    expect(cipherFailure.reason).toBe("cipher_unavailable");
    expect(noCipher.driver.exchanges).toEqual([]);
    // The claimed operation records the fixed failure instead of staying in
    // `exchanging` with no diagnosable outcome.
    expect(noCipher.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "CIPHER_UNAVAILABLE",
    });
    expect(cipherFailure.message).not.toContain("SENTINEL_NO_CIPHER");
  });

  it("validates the callback before touching the store", async () => {
    const invalidInputs: readonly unknown[] = [
      null,
      {},
      { platform: "not-a-platform", state: "s" },
      { platform: OAUTH_PLATFORM, state: "" },
      { platform: OAUTH_PLATFORM, state: "s", denied: "yes" },
      { platform: OAUTH_PLATFORM, state: "s", code: "x".repeat(2_000) },
      { platform: OAUTH_PLATFORM, state: "bad\u0000state" },
    ];
    for (const input of invalidInputs) {
      const harness = createHarness();
      const failure = await expectAuthFailure(
        completeOAuthCallback(input as OAuthCallbackInput, harness.deps),
      );
      expect(failure.code).toBe("INVALID_REQUEST");
      expect(failure.reason).toBe("callback");
      expect(harness.store.counts.claimOAuthCallback).toBe(0);
      expect(harness.driver.exchanges).toEqual([]);
    }

    const unsupported = createHarness();
    const emptyResolver = createResolverSpy({});
    const unsupportedFailure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), { ...unsupported.deps, drivers: emptyResolver.resolver }),
    );
    expect(unsupportedFailure.reason).toBe("oauth_unsupported");
    expect(unsupported.store.counts.claimOAuthCallback).toBe(0);
  });

  it("never lets a hostile callback getter or driver snapshot escape", async () => {
    const harness = createHarness();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "platform", {
      enumerable: true,
      get() {
        throw new Error("SENTINEL_CALLBACK_GETTER");
      },
    });
    const getterFailure = await expectAuthFailure(
      completeOAuthCallback(hostile as unknown as OAuthCallbackInput, harness.deps),
    );
    expect(getterFailure.code).toBe("INVALID_REQUEST");
    expect(getterFailure.reason).toBe("callback");
    expect(getterFailure.message).not.toContain("SENTINEL_CALLBACK_GETTER");
    expect(harness.store.counts.claimOAuthCallback).toBe(0);

    const hostileDriver = createDriverSpy();
    Object.defineProperty(hostileDriver.driver, "canonicalCallbackUrl", {
      get() {
        throw new Error("SENTINEL_DRIVER_GETTER");
      },
    });
    const withHostileDriver = createHarness();
    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), {
        ...withHostileDriver.deps,
        drivers: createResolverSpy({ [OAUTH_PLATFORM]: hostileDriver.driver }).resolver,
      }),
    );
    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.message).not.toContain("SENTINEL_DRIVER_GETTER");
    expect(withHostileDriver.driver.exchanges).toEqual([]);
  });
});

describe("completeOAuthCallback — protocol inputs and late failures", () => {
  it("requires the protocol-specific callback values before claiming", async () => {
    const invalid: readonly Partial<OAuthCallbackInput>[] = [
      { verifier: null },
      { requestToken: null },
      { code: "cross-protocol-code" },
      { denied: true, requestToken: null },
      { state: "state-1 " },
      { state: " state-1" },
      { verifier: "verifier-1 " },
    ];
    for (const overrides of invalid) {
      const harness = createHarness();
      await seedClaimable(harness);

      const failure = await expectAuthFailure(
        completeOAuthCallback(callbackInput(overrides), harness.deps),
      );

      expect(failure.code, JSON.stringify(overrides)).toBe("INVALID_REQUEST");
      expect(failure.reason, JSON.stringify(overrides)).toBe("callback");
      expect(harness.store.counts.claimOAuthCallback).toBe(0);
      expect(harness.cipher.decryptContexts).toEqual([]);
      expect(harness.driver.exchanges).toEqual([]);
    }
  });

  it("exchanges an OAuth2 callback that carries only state and code", async () => {
    const store = createStoreSpy();
    const driver = createDriverSpy({ protocol: "oauth2" });
    const resolver = createResolverSpy({ [OAUTH_PLATFORM]: driver.driver });
    const cipher = createCipherSpy();
    const deps: OAuthCallbackDependencies = {
      credentials: store.store,
      getCipher: () => cipher.cipher,
      drivers: resolver.resolver,
      clock: createClock(),
    };
    await seedOperation(store, { requestToken: null });

    const outcome = await completeOAuthCallback(
      { platform: OAUTH_PLATFORM, state: "state-1", code: "code-1" },
      deps,
    );

    expect(outcome.phase).toBe("awaiting_confirmation");
    expect(store.counts.claimOAuthCallback).toBe(1);
    expect(driver.exchanges).toHaveLength(1);
    expect(driver.exchanges[0]?.requestSecret).toBeNull();
    expect(cipher.decryptContexts).toEqual([]);

    for (const overrides of [
      { code: null, verifier: "verifier-1" },
      { code: null, requestToken: "request-token-1" },
      { verifier: "verifier-1" },
      { requestToken: "request-token-1" },
    ]) {
      const other = createStoreSpy();
      const otherDriver = createDriverSpy({ protocol: "oauth2" });
      const otherDeps: OAuthCallbackDependencies = {
        credentials: other.store,
        getCipher: () => cipher.cipher,
        drivers: createResolverSpy({ [OAUTH_PLATFORM]: otherDriver.driver }).resolver,
        clock: createClock(),
      };
      await seedOperation(other, { requestToken: null });

      const input: OAuthCallbackInput = {
        platform: OAUTH_PLATFORM,
        state: "state-1",
        ...(overrides as Partial<OAuthCallbackInput>),
      };
      const failure = await expectAuthFailure(
        completeOAuthCallback(input, otherDeps),
      );
      expect(failure.reason, JSON.stringify(overrides)).toBe("callback");
      expect(other.counts.claimOAuthCallback, JSON.stringify(overrides)).toBe(0);
      expect(otherDriver.exchanges, JSON.stringify(overrides)).toEqual([]);
    }
  });

  it("records a cipher failure when the candidate cannot be encrypted", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    const inner = createTestCipher();
    let encryptAttempts = 0;
    const deps: OAuthCallbackDependencies = {
      ...harness.deps,
      getCipher: () => ({
        kind: inner.kind,
        keyId: inner.keyId,
        encrypt: async () => {
          encryptAttempts += 1;
          throw new StoreUnavailable("SENTINEL_ENCRYPT");
        },
        decrypt: (envelope, context) => inner.decrypt(envelope, context),
      }),
    };

    const failure = await expectAuthFailure(completeOAuthCallback(callbackInput(), deps));

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("cipher_unavailable");
    expect(encryptAttempts).toBe(1);
    expect(harness.driver.exchanges).toHaveLength(1);
    expect(harness.store.saved[0]?.outcome).toEqual({
      kind: "failed",
      errorCode: "CIPHER_UNAVAILABLE",
    });
    expect(failure.message).not.toContain("SENTINEL_ENCRYPT");
  });

  it("never backdates a failure record when a late rejection or response arrives", async () => {
    const rejection = createHarness();
    await seedClaimable(rejection);
    let rejectionAttempts = 0;
    rejection.driver.driver.exchange = async () => {
      rejectionAttempts += 1;
      rejection.clock.set(OAUTH_TTL_END);
      throw new OAuthDriverError("unavailable");
    };

    const rejected = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), rejection.deps),
    );
    expect(rejected.code).toBe("PROVIDER_ERROR");
    expect(rejectionAttempts).toBe(1);
    expect(rejection.store.counts.saveCandidate).toBe(0);
    const rejectedRow = await readOperation(rejection.store, "op-1");
    expect(rejectedRow?.phase).toBe("exchanging");
    expect(rejectedRow?.errorCode).toBeNull();

    const malformed = createHarness();
    await seedClaimable(malformed);
    let malformedAttempts = 0;
    malformed.driver.driver.exchange = async () => {
      malformedAttempts += 1;
      malformed.clock.set(OAUTH_TTL_END);
      return {
        plaintext: "not-bytes",
        expiresAt: null,
        target: null,
        missingFields: [],
      } as never;
    };

    const invalid = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), malformed.deps),
    );
    expect(invalid.code).toBe("PROVIDER_ERROR");
    expect(invalid.reason).toBe("invalid_driver_response");
    expect(malformedAttempts).toBe(1);
    expect(malformed.store.counts.saveCandidate).toBe(0);
  });

  it("never reads a forged auth failure thrown by the driver", async () => {
    const harness = createHarness();
    await seedClaimable(harness);
    const forged = Object.create(AuthUseCaseError.prototype) as AuthUseCaseError;
    Object.defineProperty(forged, "code", {
      get() {
        throw new Error("SENTINEL_FORGED_DRIVER_CODE");
      },
    });
    Object.defineProperty(forged, "reason", {
      get() {
        throw new Error("SENTINEL_FORGED_DRIVER_REASON");
      },
    });
    harness.driver.failNextExchange(forged);

    const failure = await expectAuthFailure(
      completeOAuthCallback(callbackInput(), harness.deps),
    );

    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(failure.reason).toBe("provider_error");
    expect(failure.message).not.toContain("SENTINEL_FORGED_DRIVER");
    expect(harness.driver.exchanges).toHaveLength(1);
  });
});
