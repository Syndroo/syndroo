/**
 * Shared composition helpers for the portable OAuth tests.
 *
 * Everything here wraps the frozen snapshot fake plus small spies: no frozen
 * test double or contract is modified. Only the OAuth test files import it.
 */
import type { Platform, Publisher, PublishResult } from "@syndroo/core";

import {
  encodeBindingMaterial,
  type ActivationCommit,
  type AuthOperationStart,
  type CandidateCommit,
  type CipherContext,
  type CredentialCipher,
  type CredentialStore,
  type EncryptedSlotSnapshot,
  type IsoInstant,
  type OAuthClaim,
  type PublisherPreparation,
  type RefreshClaim,
  type RefreshCommit,
  type RefreshFailure,
  type SafePlatformStatus,
  type SlotMutation,
  type StoredAuthOperation,
} from "../src/index.js";
import type {
  OAuthBeginInput,
  OAuthBeginResult,
  OAuthConfirmInput,
  OAuthConfirmResult,
  OAuthDriver,
  OAuthDriverResolver,
  OAuthExchangeInput,
  OAuthExchangeResult,
  OAuthProtocol,
  OAuthRefreshInput,
  OAuthRefreshResult,
} from "../src/use-cases/oauth-driver.js";
import type {
  OAuthRefreshDriver,
  OAuthRefreshDriverResolver,
} from "../src/use-cases/oauth-refresh-driver.js";
import type { PreparePublisher } from "../src/use-cases/prepare-publisher.js";
import { createSnapshotFake, createTestCipher, type SnapshotFake } from "../src/testing/index.js";

export const OAUTH_NOW: IsoInstant = "2026-09-23T00:00:00.000Z";
export const OAUTH_TTL_END: IsoInstant = "2026-09-23T00:30:00.000Z";
export const OAUTH_PLATFORM: Platform = "x";

export function bodyBytes(fields: Readonly<Record<string, string>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fields));
}

export interface ClockSpy {
  now(): IsoInstant;
  set(instant: IsoInstant): void;
  readonly reads: () => number;
}

export function createClock(instant: IsoInstant = OAUTH_NOW): ClockSpy {
  let current = instant;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      return current;
    },
    set: (next: IsoInstant) => {
      current = next;
    },
    reads: () => reads,
  };
}

export interface CipherSpy {
  readonly cipher: CredentialCipher;
  readonly encryptContexts: CipherContext[];
  readonly decryptContexts: CipherContext[];
}

export function createCipherSpy(inner: CredentialCipher = createTestCipher()): CipherSpy {
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

export interface StoreSpy {
  readonly store: CredentialStore;
  readonly fake: SnapshotFake;
  readonly counts: {
    readSlot: number;
    compareAndSetSlot: number;
    createAuthOperation: number;
    claimOAuthCallback: number;
    saveCandidate: number;
    activateCandidate: number;
    readAuthOperation: number;
    acquireRefresh: number;
    completeRefresh: number;
    markReconnectRequired: number;
  };
  readonly claims: OAuthClaim[];
  readonly created: AuthOperationStart[];
  readonly saved: CandidateCommit[];
  readonly mutations: SlotMutation[];
  readonly refreshes: RefreshCommit[];
  readonly acquisitions: RefreshClaim[];
  readonly reconnectFailures: RefreshFailure[];
  failNextClaim(error: Error): void;
  failNextSave(error: Error): void;
  failNextCreate(error: Error): void;
  failNextRead(error: Error): void;
  returnNextOperation(operation: StoredAuthOperation | null): void;
  failNextActivation(error: Error): void;
  commitActivationThenThrow(): void;
  beforeActivate(hook: (input: ActivationCommit) => Promise<void>): void;
  returnNextSlot(snapshot: unknown): void;
  failNextAcquire(error: Error): void;
  afterAcquire(hook: () => Promise<void>): void;
  failNextRefreshCommit(error: Error): void;
  commitRefreshThenThrow(): void;
  beforeRefreshCommit(hook: (input: RefreshCommit) => Promise<void>): void;
  failNextReconnect(error: Error): void;
  beforeClaim(hook: (input: OAuthClaim) => Promise<void>): void;
  afterCreate(hook: () => void): void;
  beforeReadSlot(hook: () => Promise<void>): void;
}

export function createStoreSpy(): StoreSpy {
  const fake = createSnapshotFake();
  const counts = {
    readSlot: 0,
    compareAndSetSlot: 0,
    createAuthOperation: 0,
    claimOAuthCallback: 0,
    saveCandidate: 0,
    activateCandidate: 0,
    readAuthOperation: 0,
    acquireRefresh: 0,
    completeRefresh: 0,
    markReconnectRequired: 0,
  };
  const claims: OAuthClaim[] = [];
  const created: AuthOperationStart[] = [];
  const saved: CandidateCommit[] = [];
  const mutations: SlotMutation[] = [];
  const refreshes: RefreshCommit[] = [];
  const acquisitions: RefreshClaim[] = [];
  const reconnectFailures: RefreshFailure[] = [];
  let claimFailure: Error | null = null;
  let saveFailure: Error | null = null;
  let createFailure: Error | null = null;
  let readFailure: Error | null = null;
  let nextOperation: StoredAuthOperation | null = null;
  let claimHook: ((input: OAuthClaim) => Promise<void>) | null = null;
  let createHook: (() => void) | null = null;
  let readHook: (() => Promise<void>) | null = null;
  let activateHook: ((input: ActivationCommit) => Promise<void>) | null = null;
  let activateFailure: Error | null = null;
  let activationCommitThenThrow = false;
  let nextSlot: unknown = null;
  let acquireFailure: Error | null = null;
  let acquireHook: (() => Promise<void>) | null = null;
  let refreshCommitFailure: Error | null = null;
  let refreshCommitThenThrow = false;
  let refreshCommitHook: ((input: RefreshCommit) => Promise<void>) | null = null;
  let reconnectFailure: Error | null = null;

  const store: CredentialStore = {
    ...fake.credentials,
    async readSlot(input) {
      counts.readSlot += 1;
      if (readHook !== null) {
        const hook = readHook;
        readHook = null;
        await hook();
      }
      if (nextSlot !== null) {
        const snapshot = nextSlot;
        nextSlot = null;
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
      counts.compareAndSetSlot += 1;
      mutations.push(input);
      return fake.credentials.compareAndSetSlot(input);
    },
    async createAuthOperation(input) {
      counts.createAuthOperation += 1;
      created.push(input);
      if (createFailure !== null) {
        const error = createFailure;
        createFailure = null;
        throw error;
      }
      const result = await fake.credentials.createAuthOperation(input);
      if (createHook !== null) {
        const hook = createHook;
        createHook = null;
        hook();
      }
      return result;
    },
    async claimOAuthCallback(input) {
      counts.claimOAuthCallback += 1;
      claims.push(input);
      if (claimHook !== null) {
        const hook = claimHook;
        claimHook = null;
        await hook(input);
      }
      if (claimFailure !== null) {
        const error = claimFailure;
        claimFailure = null;
        throw error;
      }
      return fake.credentials.claimOAuthCallback(input);
    },
    async saveCandidate(input) {
      counts.saveCandidate += 1;
      saved.push(input);
      if (saveFailure !== null) {
        const error = saveFailure;
        saveFailure = null;
        throw error;
      }
      return fake.credentials.saveCandidate(input);
    },
    async activateCandidate(input) {
      counts.activateCandidate += 1;
      if (activateHook !== null) {
        const hook = activateHook;
        activateHook = null;
        await hook(input);
      }
      if (activateFailure !== null) {
        const error = activateFailure;
        activateFailure = null;
        throw error;
      }
      const result = await fake.credentials.activateCandidate(input);
      if (activationCommitThenThrow) {
        // The store committed; only the acknowledgement was lost.
        activationCommitThenThrow = false;
        throw new Error("SENTINEL_LOST_ACTIVATION_ACK");
      }
      return result;
    },
    async readAuthOperation(input) {
      counts.readAuthOperation += 1;
      if (readFailure !== null) {
        const error = readFailure;
        readFailure = null;
        throw error;
      }
      if (nextOperation !== null) {
        const operation = nextOperation;
        nextOperation = null;
        return operation;
      }
      return fake.credentials.readAuthOperation(input);
    },
    async acquireRefresh(input) {
      counts.acquireRefresh += 1;
      acquisitions.push(input);
      if (acquireFailure !== null) {
        const error = acquireFailure;
        acquireFailure = null;
        throw error;
      }
      const result = await fake.credentials.acquireRefresh(input);
      if (acquireHook !== null) {
        const hook = acquireHook;
        acquireHook = null;
        await hook();
      }
      return result;
    },
    async completeRefresh(input) {
      counts.completeRefresh += 1;
      refreshes.push(input);
      if (refreshCommitHook !== null) {
        const hook = refreshCommitHook;
        refreshCommitHook = null;
        await hook(input);
      }
      if (refreshCommitFailure !== null) {
        const error = refreshCommitFailure;
        refreshCommitFailure = null;
        throw error;
      }
      const result = await fake.credentials.completeRefresh(input);
      if (refreshCommitThenThrow) {
        // The commit applied; only the acknowledgement was lost.
        refreshCommitThenThrow = false;
        throw new Error("SENTINEL_LOST_REFRESH_ACK");
      }
      return result;
    },
    async markReconnectRequired(input) {
      counts.markReconnectRequired += 1;
      reconnectFailures.push(input);
      if (reconnectFailure !== null) {
        const error = reconnectFailure;
        reconnectFailure = null;
        throw error;
      }
      return fake.credentials.markReconnectRequired(input);
    },
  };

  return {
    store,
    fake,
    counts,
    claims,
    created,
    saved,
    mutations,
    refreshes,
    acquisitions,
    reconnectFailures,
    failNextClaim: (error: Error) => {
      claimFailure = error;
    },
    failNextSave: (error: Error) => {
      saveFailure = error;
    },
    failNextCreate: (error: Error) => {
      createFailure = error;
    },
    failNextRead: (error: Error) => {
      readFailure = error;
    },
    returnNextOperation: (operation: StoredAuthOperation | null) => {
      nextOperation = operation;
    },
    failNextActivation: (error: Error) => {
      activateFailure = error;
    },
    commitActivationThenThrow: () => {
      activationCommitThenThrow = true;
    },
    beforeActivate: (hook: (input: ActivationCommit) => Promise<void>) => {
      activateHook = hook;
    },
    returnNextSlot: (snapshot: unknown) => {
      nextSlot = snapshot;
    },
    failNextAcquire: (error: Error) => {
      acquireFailure = error;
    },
    afterAcquire: (hook: () => Promise<void>) => {
      acquireHook = hook;
    },
    failNextRefreshCommit: (error: Error) => {
      refreshCommitFailure = error;
    },
    commitRefreshThenThrow: () => {
      refreshCommitThenThrow = true;
    },
    beforeRefreshCommit: (hook: (input: RefreshCommit) => Promise<void>) => {
      refreshCommitHook = hook;
    },
    failNextReconnect: (error: Error) => {
      reconnectFailure = error;
    },
    beforeClaim: (hook: (input: OAuthClaim) => Promise<void>) => {
      claimHook = hook;
    },
    afterCreate: (hook: () => void) => {
      createHook = hook;
    },
    beforeReadSlot: (hook: () => Promise<void>) => {
      readHook = hook;
    },
  };
}

export interface DriverSpy {
  readonly driver: OAuthDriver;
  readonly begins: OAuthBeginInput[];
  readonly exchanges: OAuthExchangeInput[];
  readonly confirms: OAuthConfirmInput[];
  setBeginResult(result: OAuthBeginResult): void;
  setExchangeResult(result: OAuthExchangeResult): void;
  setConfirmResult(result: OAuthConfirmResult): void;
  setConfirmRawResult(value: unknown): void;
  failNextBegin(error: unknown): void;
  failNextExchange(error: unknown): void;
  failNextConfirm(error: unknown): void;
}

export interface DriverOptions {
  readonly platform?: Platform;
  readonly protocol?: OAuthProtocol;
  readonly canonicalCallbackUrl?: string;
  readonly startConfigBinding?: string;
}

export function createDriverSpy(options: DriverOptions = {}): DriverSpy {
  const platform = options.platform ?? OAUTH_PLATFORM;
  const protocol = options.protocol ?? "oauth1";
  const begins: OAuthBeginInput[] = [];
  const exchanges: OAuthExchangeInput[] = [];
  const confirms: OAuthConfirmInput[] = [];
  const requestSecret = new TextEncoder().encode("request-secret-1");
  let beginResult: OAuthBeginResult = {
    authorizationUrl: `https://provider.example/authorize?state=${platform}`,
    requestToken: protocol === "oauth1" ? "request-token-1" : null,
    requestSecret: protocol === "oauth1" ? requestSecret : null,
  };
  let exchangeResult: OAuthExchangeResult = {
    plaintext: bodyBytes({ access_token: "exchanged-token" }),
    expiresAt: null,
    target: { label: "provider-target", source: "provider" },
    missingFields: [],
  };
  let beginFailure: unknown = null;
  let exchangeFailure: unknown = null;
  let confirmFailure: unknown = null;
  let confirmResult: OAuthConfirmResult = {
    plaintext: bodyBytes({ access_token: "confirmed-token" }),
    target: null,
    missingFields: [],
  };
  let confirmRawResult: unknown = null;

  const driver: OAuthDriver = {
    platform,
    protocol,
    canonicalCallbackUrl: options.canonicalCallbackUrl ?? "https://worker.example/v1/auth/x/callback",
    startConfigBinding: options.startConfigBinding ?? "config-binding-1",
    async begin(input) {
      begins.push(input);
      if (beginFailure !== null) {
        const error = beginFailure;
        beginFailure = null;
        throw error;
      }
      return beginResult;
    },
    async exchange(input) {
      exchanges.push(input);
      if (exchangeFailure !== null) {
        const error = exchangeFailure;
        exchangeFailure = null;
        throw error;
      }
      return exchangeResult;
    },
    confirm(input) {
      confirms.push(input);
      if (confirmFailure !== null) {
        const error = confirmFailure;
        confirmFailure = null;
        throw error;
      }
      if (confirmRawResult !== null) {
        return confirmRawResult as OAuthConfirmResult;
      }
      return confirmResult;
    },
  };

  return {
    driver,
    begins,
    exchanges,
    confirms,
    setBeginResult: (result: OAuthBeginResult) => {
      beginResult = result;
    },
    setExchangeResult: (result: OAuthExchangeResult) => {
      exchangeResult = result;
    },
    setConfirmResult: (result: OAuthConfirmResult) => {
      confirmResult = result;
      confirmRawResult = null;
    },
    setConfirmRawResult: (value: unknown) => {
      confirmRawResult = value;
    },
    failNextBegin: (error: unknown) => {
      beginFailure = error;
    },
    failNextExchange: (error: unknown) => {
      exchangeFailure = error;
    },
    failNextConfirm: (error: unknown) => {
      confirmFailure = error;
    },
  };
}

export interface ResolverSpy {
  readonly resolver: OAuthDriverResolver;
  readonly calls: Platform[];
  setDriver(platform: Platform, driver: OAuthDriver | null): void;
  failNext(error: unknown): void;
}

export function createResolverSpy(
  initial: Partial<Record<Platform, OAuthDriver | null>> = {},
  options: { readonly async?: boolean } = {},
): ResolverSpy {
  const calls: Platform[] = [];
  const drivers = new Map<string, OAuthDriver | null>(Object.entries(initial));
  let failure: unknown = null;
  const resolve = (platform: Platform): OAuthDriver | null | Promise<OAuthDriver | null> => {
    calls.push(platform);
    const produce = (): OAuthDriver | null => {
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
      return drivers.get(platform) ?? null;
    };
    return options.async === true ? Promise.resolve().then(produce) : produce();
  };
  return {
    resolver: resolve,
    calls,
    setDriver: (platform: Platform, driver: OAuthDriver | null) => {
      drivers.set(platform, driver);
    },
    failNext: (error: unknown) => {
      failure = error;
    },
  };
}

export interface PrepareStub {
  readonly prepare: PreparePublisher;
  readonly calls: { readonly platform: Platform; readonly now: IsoInstant }[];
  failNext(error: unknown): void;
  setBlocked(readiness: SafePlatformStatus["readiness"]): void;
}

export function stubPublisher(platform: Platform): Publisher {
  return {
    name: `${platform}-provider`,
    async publish(): Promise<PublishResult> {
      return { externalId: "stub" };
    },
  };
}

export function createPrepareStub(): PrepareStub {
  const calls: { platform: Platform; now: IsoInstant }[] = [];
  let failure: unknown = null;
  let blocked: SafePlatformStatus["readiness"] | null = null;
  const prepare: PreparePublisher = async (platform, now) => {
    calls.push({ platform, now });
    if (failure !== null) {
      const error = failure;
      failure = null;
      throw error;
    }
    if (blocked !== null) {
      const status: SafePlatformStatus = {
        platform,
        configured: false,
        source: null,
        oauthSupported: true,
        readiness: blocked,
        missingFields: [],
        expiresAt: null,
        revision: 0,
      };
      const preparation: PublisherPreparation = {
        kind: "blocked",
        reason: "unavailable",
        readiness: blocked,
        status,
        missingFields: [],
      };
      return preparation;
    }
    const status: SafePlatformStatus = {
      platform,
      configured: true,
      source: "env",
      oauthSupported: true,
      readiness: "ready",
      missingFields: [],
      expiresAt: null,
      revision: 0,
    };
    const preparation: PublisherPreparation = {
      kind: "ready",
      prepared: {
        platform,
        publisher: stubPublisher(platform),
        status,
        target: null,
        slotBindingId: null,
        bindingMaterial: encodeBindingMaterial({
          platform,
          source: "env",
          fields: [["slotBinding", null]],
        }),
        credentialRevision: 0,
        credentialSource: "env",
      },
    };
    return preparation;
  };
  return {
    prepare,
    calls,
    failNext: (error: unknown) => {
      failure = error;
    },
    setBlocked: (readiness: SafePlatformStatus["readiness"]) => {
      blocked = readiness;
    },
  };
}

/** Seed the fake's operation table through the frozen store surface. */
export async function seedOperation(
  spy: StoreSpy,
  overrides: Partial<AuthOperationStart> = {},
): Promise<AuthOperationStart> {
  const start: AuthOperationStart = {
    operationId: "op-1",
    platform: OAUTH_PLATFORM,
    now: OAUTH_NOW,
    expectedRevision: 0,
    canonicalCallbackUrl: "https://worker.example/v1/auth/x/callback",
    startConfigBinding: "config-binding-1",
    oauthState: "state-1",
    requestToken: "request-token-1",
    requestSecret: null,
    requestSecretPurpose: null,
    requestSecretRevision: null,
    expiresAt: OAUTH_TTL_END,
    ...overrides,
  };
  await spy.fake.credentials.createAuthOperation(start);
  return start;
}

/** Read one stored operation for assertions. */
export async function readOperation(
  spy: StoreSpy,
  operationId: string,
): Promise<StoredAuthOperation | null> {
  return spy.fake.credentials.readAuthOperation({ operationId });
}

export interface RefreshDriverSpy {
  readonly driver: OAuthRefreshDriver;
  readonly refreshes: OAuthRefreshInput[];
  readonly canRefreshCalls: () => number;
  setCanRefresh(value: boolean | ((plaintext: Uint8Array) => boolean)): void;
  setCanRefreshRaw(value: unknown): void;
  setRefreshResult(result: OAuthRefreshResult): void;
  failNextCanRefresh(error: unknown): void;
  failNextRefresh(error: unknown): void;
}

export function createRefreshDriverSpy(
  options: { readonly platform?: Platform; readonly canRefresh?: boolean } = {},
): RefreshDriverSpy {
  const platform = options.platform ?? OAUTH_PLATFORM;
  const refreshes: OAuthRefreshInput[] = [];
  let canRefreshValue: boolean | ((plaintext: Uint8Array) => boolean) =
    options.canRefresh ?? true;
  let canRefreshRaw: unknown = null;
  let canRefreshFailure: unknown = null;
  let refreshFailure: unknown = null;
  let canRefreshCalls = 0;
  let refreshResult: OAuthRefreshResult = {
    plaintext: bodyBytes({ access_token: "refreshed-token", refresh_token: "new-refresh" }),
    expiresAt: "2026-12-31T23:59:59.000Z",
  };

  const driver: OAuthRefreshDriver = {
    platform,
    canRefresh(plaintext) {
      canRefreshCalls += 1;
      if (canRefreshFailure !== null) {
        const error = canRefreshFailure;
        canRefreshFailure = null;
        throw error;
      }
      if (canRefreshRaw !== null) {
        return canRefreshRaw as boolean;
      }
      return typeof canRefreshValue === "function"
        ? canRefreshValue(plaintext)
        : canRefreshValue;
    },
    async refresh(input) {
      refreshes.push(input);
      if (refreshFailure !== null) {
        const error = refreshFailure;
        refreshFailure = null;
        throw error;
      }
      return refreshResult;
    },
  };

  return {
    driver,
    refreshes,
    canRefreshCalls: () => canRefreshCalls,
    setCanRefresh: (value) => {
      canRefreshValue = value;
      canRefreshRaw = null;
    },
    setCanRefreshRaw: (value) => {
      canRefreshRaw = value;
    },
    setRefreshResult: (result) => {
      refreshResult = result;
    },
    failNextCanRefresh: (error) => {
      canRefreshFailure = error;
    },
    failNextRefresh: (error) => {
      refreshFailure = error;
    },
  };
}

export interface RefreshResolverSpy {
  readonly resolver: OAuthRefreshDriverResolver;
  readonly calls: Platform[];
  setDriver(platform: Platform, driver: OAuthRefreshDriver | null): void;
  failNext(error: unknown): void;
}

export function createRefreshResolverSpy(
  initial: Partial<Record<Platform, OAuthRefreshDriver | null>> = {},
  options: { readonly async?: boolean } = {},
): RefreshResolverSpy {
  const calls: Platform[] = [];
  const drivers = new Map<string, OAuthRefreshDriver | null>(Object.entries(initial));
  let failure: unknown = null;
  const resolve = (
    platform: Platform,
  ): OAuthRefreshDriver | null | Promise<OAuthRefreshDriver | null> => {
    calls.push(platform);
    const produce = (): OAuthRefreshDriver | null => {
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
      return drivers.get(platform) ?? null;
    };
    return options.async === true ? Promise.resolve().then(produce) : produce();
  };
  return {
    resolver: resolve,
    calls,
    setDriver: (platform: Platform, driver: OAuthRefreshDriver | null) => {
      drivers.set(platform, driver);
    },
    failNext: (error: unknown) => {
      failure = error;
    },
  };
}
