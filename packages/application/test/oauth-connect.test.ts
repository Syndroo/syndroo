/**
 * Task T6c1 — portable OAuth connect tests.
 *
 * Every case asserts the exact outbound step count, because connect is the one
 * place where a stale revision, a missing key or a late clock could turn into an
 * unnecessary request-token call.
 */
import { describe, expect, it } from "vitest";

import { InvalidContractInputError, StoreUnavailable, type CredentialCipher } from "../src/index.js";
import { AuthUseCaseError } from "../src/use-cases/auth-errors.js";
import {
  beginOAuthConnect,
  OAUTH_REQUEST_SECRET_GENERATION,
  type OAuthConnectDependencies,
} from "../src/use-cases/oauth-connect.js";
import { OAuthDriverError } from "../src/use-cases/oauth-driver.js";
import { createTestCipher } from "../src/testing/index.js";
import {
  OAUTH_NOW,
  OAUTH_PLATFORM,
  OAUTH_TTL_END,
  createCipherSpy,
  createClock,
  createDriverSpy,
  createResolverSpy,
  createStoreSpy,
} from "./oauth-test-support.js";

interface ConnectHarness {
  readonly deps: OAuthConnectDependencies;
  readonly store: ReturnType<typeof createStoreSpy>;
  readonly driver: ReturnType<typeof createDriverSpy>;
  readonly resolver: ReturnType<typeof createResolverSpy>;
  readonly cipher: ReturnType<typeof createCipherSpy>;
  readonly clock: ReturnType<typeof createClock>;
}

function createHarness(options: { readonly protocol?: "oauth1" | "oauth2" } = {}): ConnectHarness {
  const store = createStoreSpy();
  const driver = createDriverSpy({ protocol: options.protocol ?? "oauth1" });
  const resolver = createResolverSpy({ [OAUTH_PLATFORM]: driver.driver });
  const cipher = createCipherSpy();
  const clock = createClock();
  const ids = ["state-1", "op-1"] as const;
  let index = 0;
  const deps: OAuthConnectDependencies = {
    credentials: store.store,
    getCipher: () => cipher.cipher,
    drivers: resolver.resolver,
    clock,
    ids: () => ids[index++] ?? "extra-id",
  };
  return { deps, store, driver, resolver, cipher, clock };
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

describe("beginOAuthConnect — happy paths", () => {
  it("creates one OAuth1 operation and encrypts the request secret", async () => {
    const harness = createHarness();

    const receipt = await beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps);

    expect(receipt).toEqual({
      platform: OAUTH_PLATFORM,
      operationId: "op-1",
      url: "https://provider.example/authorize?state=x",
      expiresAt: OAUTH_TTL_END,
      expectedRevision: 0,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(harness.driver.begins).toHaveLength(1);
    expect(harness.driver.begins[0]?.state).toBe("state-1");
    expect(harness.store.counts.createAuthOperation).toBe(1);
    const start = harness.store.created[0];
    expect(start?.operationId).toBe("op-1");
    expect(start?.oauthState).toBe("state-1");
    expect(start?.requestToken).toBe("request-token-1");
    expect(start?.requestSecretPurpose).toBe("oauth_request_secret");
    expect(start?.requestSecretRevision).toBe(OAUTH_REQUEST_SECRET_GENERATION);
    expect(start?.expiresAt).toBe(OAUTH_TTL_END);
    expect(start?.startConfigBinding).toBe("config-binding-1");
    expect(start?.canonicalCallbackUrl).toBe("https://worker.example/v1/auth/x/callback");
    expect(harness.cipher.encryptContexts).toEqual([
      {
        purpose: "oauth_request_secret",
        recordId: "op-1",
        platform: OAUTH_PLATFORM,
        payloadSchemaVersion: 1,
        payloadRevision: OAUTH_REQUEST_SECRET_GENERATION,
      },
    ]);
  });

  it("performs no request-secret encryption for OAuth2 but still checks the cipher", async () => {
    const harness = createHarness({ protocol: "oauth2" });

    const receipt = await beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps);

    expect(receipt.expiresAt).toBe(OAUTH_TTL_END);
    expect(harness.cipher.encryptContexts).toEqual([]);
    expect(harness.store.created[0]?.requestSecret).toBeNull();
    expect(harness.store.created[0]?.requestSecretPurpose).toBeNull();
    expect(harness.store.counts.createAuthOperation).toBe(1);
  });

  it("uses the observed revision when expectedRevision is omitted", async () => {
    const harness = createHarness();
    await harness.store.fake.credentials.compareAndSetSlot({
      platform: OAUTH_PLATFORM,
      expectedRevision: 0,
      now: OAUTH_NOW,
      change: { kind: "remove" },
    });

    const receipt = await beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps);

    expect(receipt.expectedRevision).toBe(1);
    expect(harness.store.created[0]?.expectedRevision).toBe(1);
  });

  it("supports an asynchronous driver resolver", async () => {
    const harness = createHarness();
    const asyncResolver = createResolverSpy({ [OAUTH_PLATFORM]: harness.driver.driver }, {
      async: true,
    });

    const receipt = await beginOAuthConnect(
      { platform: OAUTH_PLATFORM },
      { ...harness.deps, drivers: asyncResolver.resolver },
    );

    expect(receipt.operationId).toBe("op-1");
    expect(asyncResolver.calls).toEqual([OAUTH_PLATFORM]);
  });
});

describe("beginOAuthConnect — guarded failures", () => {
  it("performs zero provider calls on a revision mismatch", async () => {
    const harness = createHarness();

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM, expectedRevision: 5 }, harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("revision_mismatch");
    expect(harness.driver.begins).toEqual([]);
    expect(harness.store.counts.createAuthOperation).toBe(0);
  });

  it("rejects an unsupported platform before reading storage", async () => {
    const harness = createHarness();
    const empty = createResolverSpy({});

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, { ...harness.deps, drivers: empty.resolver }),
    );

    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.reason).toBe("oauth_unsupported");
    expect(harness.store.counts.readSlot).toBe(0);
    expect(harness.driver.begins).toEqual([]);
  });

  it("reports a failing resolver as an instance problem", async () => {
    const harness = createHarness();
    harness.resolver.failNext(new Error("SENTINEL_RESOLVER"));

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("unavailable");
    expect(failure.message).not.toContain("SENTINEL_RESOLVER");
    expect(harness.driver.begins).toEqual([]);
  });

  it("checks the cipher before the request-token call for both protocols", async () => {
    for (const protocol of ["oauth1", "oauth2"] as const) {
      const harness = createHarness({ protocol });
      const throwing = {
        ...harness.deps,
        getCipher: (): CredentialCipher => {
          throw new StoreUnavailable("SENTINEL_CIPHER");
        },
      };

      const failure = await expectAuthFailure(
        beginOAuthConnect({ platform: OAUTH_PLATFORM }, throwing),
      );

      expect(failure.code, protocol).toBe("INSTANCE_NOT_READY");
      expect(failure.reason, protocol).toBe("cipher_unavailable");
      expect(failure.message).not.toContain("SENTINEL_CIPHER");
      expect(harness.driver.begins, protocol).toEqual([]);
      expect(harness.store.counts.createAuthOperation, protocol).toBe(0);
    }
  });

  it("never lets a provider failure or its text escape", async () => {
    const harness = createHarness();
    harness.driver.failNextBegin(new OAuthDriverError("denied"));

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(failure.reason).toBe("provider_error");
    expect(harness.store.counts.createAuthOperation).toBe(0);

    const second = createHarness();
    second.driver.failNextBegin(new Error("SENTINEL_PROVIDER_TEXT"));
    const other = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, second.deps),
    );
    expect(other.message).not.toContain("SENTINEL_PROVIDER_TEXT");
    expect(JSON.stringify(other)).not.toContain("SENTINEL_PROVIDER_TEXT");
  });

  it("rejects malformed begin results with zero operations", async () => {
    const cases = [
      { authorizationUrl: "http://provider.example/authorize" },
      { authorizationUrl: "https://provider.example/authorize", requestToken: null, requestSecret: null },
      {
        authorizationUrl: "https://provider.example/authorize",
        requestToken: "t",
        requestSecret: "not-bytes" as unknown as Uint8Array,
      },
    ];
    for (const result of cases) {
      const harness = createHarness();
      harness.driver.setBeginResult({
        requestToken: "request-token-1",
        requestSecret: new TextEncoder().encode("secret"),
        ...result,
      });

      const failure = await expectAuthFailure(
        beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps),
      );

      expect(failure.code).toBe("PROVIDER_ERROR");
      expect(harness.store.counts.createAuthOperation).toBe(0);
    }

    const oauth2 = createHarness({ protocol: "oauth2" });
    oauth2.driver.setBeginResult({
      authorizationUrl: "https://provider.example/authorize",
      requestToken: "unexpected",
      requestSecret: new TextEncoder().encode("unexpected"),
    });
    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, oauth2.deps),
    );
    expect(failure.code).toBe("PROVIDER_ERROR");
    expect(oauth2.store.counts.createAuthOperation).toBe(0);
  });

  it("returns no receipt when the operation write fails, and never retries", async () => {
    const harness = createHarness();
    harness.store.failNextCreate(new StoreUnavailable("SENTINEL_CREATE"));

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.reason).toBe("store_unavailable");
    expect(failure.message).not.toContain("SENTINEL_CREATE");
    expect(harness.store.counts.createAuthOperation).toBe(1);
    expect(harness.driver.begins).toHaveLength(1);
    expect(harness.store.fake.snapshot().operations).toEqual([]);
  });

  it("refuses to create an operation that outlived its own window", async () => {
    const harness = createHarness();
    const original = harness.driver.driver.begin.bind(harness.driver.driver);
    harness.driver.driver.begin = async (input) => {
      harness.clock.set(OAUTH_TTL_END);
      return original(input);
    };

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("operation_expired");
    expect(harness.store.counts.createAuthOperation).toBe(0);
  });

  it("rejects a storage read failure and malformed input before any provider call", async () => {
    const readFail = createHarness();
    readFail.store.failNextRead(new StoreUnavailable("SENTINEL_READ"));
    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, readFail.deps),
    );
    expect(failure.code).toBe("STORE_UNAVAILABLE");
    expect(failure.message).not.toContain("SENTINEL_READ");
    expect(readFail.driver.begins).toEqual([]);

    for (const input of [
      null,
      {},
      { platform: "not-a-platform" },
      { platform: OAUTH_PLATFORM, expectedRevision: -1 },
      { platform: OAUTH_PLATFORM, expectedRevision: 1.5 },
    ]) {
      const harness = createHarness();
      const invalid = await expectAuthFailure(
        beginOAuthConnect(input as { platform: "x" }, harness.deps),
      );
      expect(invalid.code).toBe("INVALID_REQUEST");
      expect(harness.store.counts.readSlot).toBe(0);
      expect(harness.driver.begins).toEqual([]);
    }
  });

  it("rejects a bad identifier factory as a contract violation", async () => {
    const harness = createHarness();
    const failingIds = { ...harness.deps, ids: () => "not opaque!" };
    await expect(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, failingIds),
    ).rejects.toBeInstanceOf(InvalidContractInputError);

    const sameIds = { ...harness.deps, ids: () => "same-value" };
    await expect(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, sameIds),
    ).rejects.toBeInstanceOf(InvalidContractInputError);
  });
});

describe("beginOAuthConnect — captured driver snapshot", () => {
  it("uses the captured identity and bound methods when the original mutates", async () => {
    const harness = createHarness();
    const original = harness.driver.driver as unknown as {
      canonicalCallbackUrl: string;
      startConfigBinding: string;
      begin: (...args: never[]) => unknown;
    };
    let replacementCalled = false;
    harness.store.beforeReadSlot(async () => {
      original.canonicalCallbackUrl = "https://mutated.example/callback";
      original.startConfigBinding = "mutated-binding-0001";
      original.begin = () => {
        replacementCalled = true;
        throw new Error("SENTINEL_REPLACED_BEGIN");
      };
    });

    const receipt = await beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps);

    expect(receipt.operationId).toBe("op-1");
    expect(receipt.url).toBe("https://provider.example/authorize?state=x");
    expect(replacementCalled).toBe(false);
    expect(harness.store.created[0]?.canonicalCallbackUrl).toBe(
      "https://worker.example/v1/auth/x/callback",
    );
    expect(harness.store.created[0]?.startConfigBinding).toBe("config-binding-1");
  });

  it("refuses to create when the awaited encryption outlives the window", async () => {
    const harness = createHarness();
    const inner = createTestCipher();
    const deps = {
      ...harness.deps,
      getCipher: () => ({
        kind: inner.kind,
        keyId: inner.keyId,
        encrypt: async (payload: Uint8Array, context: Parameters<typeof inner.encrypt>[1]) => {
          harness.clock.set(OAUTH_TTL_END);
          return inner.encrypt(payload, context);
        },
        decrypt: (envelope: Parameters<typeof inner.decrypt>[0], context: Parameters<typeof inner.decrypt>[1]) =>
          inner.decrypt(envelope, context),
      }),
    };

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, deps),
    );

    expect(failure.code).toBe("AUTH_CONFLICT");
    expect(failure.reason).toBe("operation_expired");
    expect(harness.store.counts.createAuthOperation).toBe(0);
  });

  it("validates the callback origin, the binding and the method shapes", async () => {
    const cases: readonly Record<string, unknown>[] = [
      { startConfigBinding: "short" },
      { startConfigBinding: "has spaces in it 1234" },
      { canonicalCallbackUrl: "https://worker.example/v1/auth/x/callback?state=1" },
      { canonicalCallbackUrl: "https://worker.example/v1/auth/x/callback#frag" },
      { canonicalCallbackUrl: "http://worker.example/v1/auth/x/callback" },
      { canonicalCallbackUrl: " https://worker.example/cb" },
      { begin: undefined },
      { exchange: undefined },
      { confirm: undefined },
      { refresh: "not-a-function" },
    ];
    for (const overrides of cases) {
      const harness = createHarness();
      const base = harness.driver.driver as unknown as Record<string, unknown>;
      const candidate = { ...base, ...overrides };
      const resolver = createResolverSpy({
        [OAUTH_PLATFORM]: candidate as unknown as (typeof harness.driver)["driver"],
      });

      const failure = await expectAuthFailure(
        beginOAuthConnect({ platform: OAUTH_PLATFORM }, { ...harness.deps, drivers: resolver.resolver }),
      );

      expect(failure.code, JSON.stringify(overrides)).toBe("INSTANCE_NOT_READY");
      expect(failure.reason, JSON.stringify(overrides)).toBe("invalid_driver_response");
      expect(harness.driver.begins, JSON.stringify(overrides)).toEqual([]);
      expect(harness.store.counts.createAuthOperation).toBe(0);
    }
  });

  it("never reads a forged auth failure's properties", async () => {
    const harness = createHarness();
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
    harness.resolver.failNext(forged);

    const failure = await expectAuthFailure(
      beginOAuthConnect({ platform: OAUTH_PLATFORM }, harness.deps),
    );

    expect(failure.code).toBe("INSTANCE_NOT_READY");
    expect(failure.reason).toBe("unavailable");
    expect(failure.message).not.toContain("SENTINEL_FORGED");
  });
});
