import { describe, expect, it, vi } from "vitest";

import {
  PublishError,
  type PublishErrorCode,
  type Platform,
  type Publisher,
  type PublishRequest,
  type PublishResult,
} from "@syndroo/core";

import {
  assertSanitizedArchive,
  commitConflict,
  computeCredentialBinding,
  encodeBindingMaterial,
  type ArchiveStore,
  type BindingMaterial,
  type BindingSigner,
  type CommitResult,
  type ExecutionLookup,
  type ExecutionSnapshot,
  type Logger,
  type OutboxStore,
  type PublisherBlockReason,
  type PublisherPreparation,
  type PublishingStore,
  type QueueEnvelopeV1,
  type SafeLogEvent,
  type SafePlatformStatus,
} from "../src/index.js";
import { writeArchiveBestEffort } from "../src/use-cases/execution-archive.js";
import {
  executePublication,
  type ExecutePublicationDependencies,
} from "../src/use-cases/execute-publication.js";
import { planArchive, type ExecutionIdFactory } from "../src/use-cases/execution-policy.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  instant,
  testEnvelope,
  type SnapshotFake,
} from "../src/testing/index.js";

const HEX = "a".repeat(64);
const PUBLICATION_ID = "pub_exec1";
const JOB_ID = "job_exec1";

/** Real WebCrypto HMAC so the binding path is exercised, not simulated. */
function testSigner(): BindingSigner {
  return {
    async sign(material: BindingMaterial): Promise<string> {
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(7),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const buffer = new ArrayBuffer(material.bytes.byteLength);
      new Uint8Array(buffer).set(material.bytes);
      const signature = await crypto.subtle.sign("HMAC", key, buffer);
      return [...new Uint8Array(signature)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

function bindingMaterialFor(platform: Platform, variant: string): BindingMaterial {
  return encodeBindingMaterial({
    platform,
    source: "credential",
    fields: [
      ["slotBinding", variant],
      ["X_API_KEY", "test-key"],
    ],
  });
}

interface PublisherSpy {
  readonly publisher: Publisher;
  readonly calls: PublishRequest[];
}

function publisherSpy(
  name: string,
  behaviour: (request: PublishRequest) => Promise<PublishResult> = async () => ({
    externalId: "ext-1",
  }),
): PublisherSpy {
  const calls: PublishRequest[] = [];
  return {
    calls,
    publisher: {
      name,
      async publish(request: PublishRequest): Promise<PublishResult> {
        calls.push(request);
        return behaviour(request);
      },
    },
  };
}

function readyPreparation(
  platform: Platform,
  input: { readonly variant?: string; readonly revision?: number; readonly publisher?: Publisher } = {},
): PublisherPreparation {
  const variant = input.variant ?? "slot-a";
  const revision = input.revision ?? 0;
  const status: SafePlatformStatus = {
    platform,
    configured: true,
    source: "credential",
    oauthSupported: false,
    readiness: "ready",
    missingFields: [],
    expiresAt: null,
    revision,
  };
  return {
    kind: "ready",
    prepared: {
      platform,
      publisher: input.publisher ?? publisherSpy(`${platform}-provider`).publisher,
      status,
      target: null,
      slotBindingId: variant,
      bindingMaterial: bindingMaterialFor(platform, variant),
      credentialRevision: revision,
      credentialSource: "credential",
    },
  };
}

function blockedPreparation(platform: Platform, reason: PublisherBlockReason): PublisherPreparation {
  // `invalid_configuration` has no Readiness twin; the safe projection is the
  // nearest public readiness value.
  const readiness: SafePlatformStatus["readiness"] =
    reason === "invalid_configuration" ? "needs_configuration" : reason;
  const status: SafePlatformStatus = {
    platform,
    configured: false,
    source: null,
    oauthSupported: false,
    readiness,
    missingFields: [],
    expiresAt: null,
    revision: 0,
  };
  return { kind: "blocked", reason, status, readiness, missingFields: [] };
}

function executionIds(): ExecutionIdFactory {
  const counts = new Map<string, number>();
  return (kind) => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return `${kind}_${next}`;
  };
}

interface SeedOptions {
  readonly publicationId?: string;
  readonly jobId?: string;
  readonly platform?: Platform;
  readonly content?: string;
  readonly binding?: string;
  readonly revision?: number;
  readonly availableAt?: string;
  readonly scheduledAt?: string | null;
}

async function seedPublication(
  fake: SnapshotFake,
  options: SeedOptions = {},
): Promise<{ readonly publicationId: string; readonly jobId: string }> {
  const publicationId = options.publicationId ?? PUBLICATION_ID;
  const jobId = options.jobId ?? JOB_ID;
  const postId = `post_${publicationId}`;
  const platform = options.platform ?? "x";
  const scheduledAt = options.scheduledAt ?? null;
  const content = options.content ?? "hello syndroo";
  await fake.publishing.createPostWithDispatch({
    scope: "posts.create.v1",
    idempotencyKey: null,
    requestFingerprint: `fingerprint-${publicationId}`,
    now: FIXTURE_NOW,
    post: {
      id: postId,
      content,
      platforms: [platform],
      overrides: {},
      scheduledAt,
      status: scheduledAt === null ? "queued" : "scheduled",
      createdAt: FIXTURE_NOW,
    },
    publications: [
      {
        id: publicationId,
        postId,
        platform,
        provider: `${platform}-provider`,
        content,
        status: scheduledAt === null ? "pending" : "scheduled",
        scheduledAt,
        credentialBinding: options.binding ?? `v1:${HEX}`,
        credentialRevision: options.revision ?? 0,
        createdAt: FIXTURE_NOW,
      },
    ],
    jobs: [
      {
        id: jobId,
        kind: "delivery.execute",
        aggregateId: publicationId,
        attemptNo: 1,
        availableAt: options.availableAt ?? FIXTURE_NOW,
      },
    ],
    credentialGuards: [{ platform, expectedRevision: options.revision ?? 0, bindingId: null }],
  });
  return { publicationId, jobId };
}

function envelopeFor(
  publicationId: string = PUBLICATION_ID,
  jobId: string = JOB_ID,
  enqueuedAt: string = FIXTURE_NOW,
): QueueEnvelopeV1 {
  return {
    version: 1,
    jobId,
    kind: "delivery.execute",
    entityId: publicationId,
    enqueuedAt,
  };
}

/** Test double for legacy/corrupt rows the create path can no longer produce. */
function viewStore(
  fake: SnapshotFake,
  mutate: (snapshot: ExecutionSnapshot) => ExecutionSnapshot,
): PublishingStore {
  return {
    ...fake.publishing,
    async getExecution(input: ExecutionLookup): Promise<ExecutionSnapshot | null> {
      const snapshot = await fake.publishing.getExecution(input);
      return snapshot === null ? null : mutate(snapshot);
    },
  };
}

interface DependencyOverrides {
  readonly prepare?: ExecutePublicationDependencies["prepare"];
  readonly signer?: BindingSigner;
  readonly publishing?: PublishingStore;
  readonly outbox?: OutboxStore;
  readonly archive?: ArchiveStore;
  readonly logger?: Logger;
  readonly archiveBudgetMs?: number;
  readonly clock?: ExecutePublicationDependencies["clock"];
  readonly ids?: ExecutionIdFactory;
}

function depsFor(
  fake: SnapshotFake,
  overrides: DependencyOverrides = {},
): ExecutePublicationDependencies {
  return {
    publishing: overrides.publishing ?? fake.publishing,
    outbox: overrides.outbox ?? fake.outbox,
    prepare: overrides.prepare ?? (async (platform) => readyPreparation(platform)),
    signer: overrides.signer ?? testSigner(),
    clock: overrides.clock ?? { now: () => FIXTURE_NOW },
    ids: overrides.ids ?? executionIds(),
    ...(overrides.archive === undefined ? {} : { archive: overrides.archive }),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    ...(overrides.archiveBudgetMs === undefined
      ? {}
      : { archiveBudgetMs: overrides.archiveBudgetMs }),
  };
}

function collectingLogger(): { logger: Logger; events: SafeLogEvent[] } {
  const events: SafeLogEvent[] = [];
  return {
    events,
    logger: {
      write(event: SafeLogEvent): void {
        events.push(event);
      },
    },
  };
}

/** A prepared publisher bound to `variant`, plus the signer that matches it. */
async function boundSetup(
  fake: SnapshotFake,
  behaviour?: (request: PublishRequest) => Promise<PublishResult>,
  overrides: DependencyOverrides = {},
): Promise<{ readonly spy: PublisherSpy; readonly deps: ExecutePublicationDependencies }> {
  const variant = "slot-a";
  const signer = overrides.signer ?? testSigner();
  const binding = await computeCredentialBinding(bindingMaterialFor("x", variant), signer);
  await seedPublication(fake, { binding });
  const spy = publisherSpy("x-provider", behaviour);
  const deps = depsFor(fake, {
    ...overrides,
    signer,
    prepare:
      overrides.prepare ??
      (async (platform) => readyPreparation(platform, { variant, publisher: spy.publisher })),
  });
  return { spy, deps };
}

describe("executePublication envelope and eligibility", () => {
  it("rejects a malformed envelope without reading the store or a provider", async () => {
    const fake = createSnapshotFake();
    let reads = 0;
    const publishing = viewStore(fake, (snapshot) => {
      reads += 1;
      return snapshot;
    });
    const spy = publisherSpy("x-provider");
    const deps = depsFor(fake, {
      publishing,
      prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
    });

    const malformed: readonly unknown[] = [
      "not-an-envelope",
      null,
      {},
      { ...envelopeFor(), version: 2 },
      { ...envelopeFor(), kind: "delivery.other" },
      { ...envelopeFor(), entityId: undefined },
      { ...envelopeFor(), extra: "unexpected" },
      { ...envelopeFor(), big: "x".repeat(4000) },
    ];
    for (const message of malformed) {
      expect(await executePublication(message, deps)).toEqual({
        kind: "infrastructure_retry",
        reason: "malformed_envelope",
      });
    }
    expect(reads).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });

  it("settles an unknown, superseded, unsupported or cancelled job without a provider", async () => {
    const unknown = createSnapshotFake();
    await seedPublication(unknown);
    expect(await executePublication(envelopeFor("pub_other", JOB_ID), depsFor(unknown))).toEqual({
      kind: "settled",
      reason: "stale_job",
    });
    expect(await executePublication(envelopeFor(PUBLICATION_ID, "job_other"), depsFor(unknown))).toEqual(
      { kind: "settled", reason: "stale_job" },
    );

    const superseded = createSnapshotFake();
    await seedPublication(superseded);
    const movedCurrentJob = viewStore(superseded, (snapshot) => ({
      ...snapshot,
      publication: { ...snapshot.publication, currentJobId: "job_newer" },
    }));
    const spy = publisherSpy("x-provider");
    expect(
      await executePublication(
        envelopeFor(),
        depsFor(superseded, {
          publishing: movedCurrentJob,
          prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
        }),
      ),
    ).toEqual({ kind: "settled", reason: "stale_job" });

    const unsupported = createSnapshotFake();
    await seedPublication(unsupported);
    const legacyKind = viewStore(unsupported, (snapshot) => ({
      ...snapshot,
      job: { ...snapshot.job, kind: "delivery.legacy" as typeof snapshot.job.kind },
    }));
    expect(
      await executePublication(envelopeFor(), depsFor(unsupported, { publishing: legacyKind })),
    ).toEqual({ kind: "settled", reason: "stale_job" });

    const cancelled = createSnapshotFake();
    await seedPublication(cancelled);
    const cancelledJob = viewStore(cancelled, (snapshot) => ({
      ...snapshot,
      job: { ...snapshot.job, status: "cancelled" as typeof snapshot.job.status },
    }));
    expect(
      await executePublication(envelopeFor(), depsFor(cancelled, { publishing: cancelledJob })),
    ).toEqual({ kind: "settled", reason: "stale_job" });
    expect(spy.calls).toHaveLength(0);
  });

  it("settles a terminal publication and a live claim without a provider", async () => {
    const terminal = createSnapshotFake();
    await seedPublication(terminal);
    const alreadyPublished = viewStore(terminal, (snapshot) => ({
      ...snapshot,
      publication: {
        ...snapshot.publication,
        status: "published" as typeof snapshot.publication.status,
      },
    }));
    const spy = publisherSpy("x-provider");
    const deps = depsFor(terminal, {
      publishing: alreadyPublished,
      prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
    });
    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "terminal",
    });

    const claimed = createSnapshotFake();
    await seedPublication(claimed);
    const claim = await claimed.publishing.claimExecution({
      jobId: JOB_ID,
      publicationId: PUBLICATION_ID,
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_other_worker",
      attemptId: "attempt_other_worker",
    });
    expect(claim.kind).toBe("claimed");
    const claimedDeps = depsFor(claimed, {
      prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
    });
    expect(await executePublication(envelopeFor(), claimedDeps)).toEqual({
      kind: "settled",
      reason: "duplicate",
    });
    expect(spy.calls).toHaveLength(0);
  });

  it("invokes exactly one provider across concurrent duplicates", async () => {
    const fake = createSnapshotFake();
    const { spy, deps } = await boundSetup(fake);
    const outcomes = await Promise.all([
      executePublication(envelopeFor(), deps),
      executePublication(envelopeFor(), deps),
    ]);
    expect(spy.calls).toHaveLength(1);
    const executed = outcomes.filter(
      (outcome) => outcome.kind === "settled" && outcome.reason === "executed",
    );
    expect(executed).toHaveLength(1);
    // The loser settles safely: a live claim (duplicate), the winner's terminal
    // outcome (terminal) or the completed transport intent (stale_job). None of
    // those paths may call the provider or consume a second attempt.
    for (const outcome of outcomes) {
      if (outcome === executed[0]) continue;
      expect(outcome.kind).toBe("settled");
      expect(["duplicate", "terminal", "stale_job"]).toContain(
        (outcome as { readonly reason: string }).reason,
      );
    }
    expect(fake.snapshot().publications[0]?.status).toBe("published");
    expect(fake.snapshot().publications[0]?.attempts).toBe(1);
    expect(fake.snapshot().jobs[0]?.status).toBe("cancelled");
  });

  it("re-arms a future current job and only settles once intent is durable", async () => {
    const future = instant(600_000);
    const fake = createSnapshotFake();
    await seedPublication(fake, { availableAt: future });
    const spy = publisherSpy("x-provider");
    const deps = depsFor(fake, {
      prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "not_due",
    });
    const job = fake.snapshot().jobs[0];
    expect(job?.status).toBe("pending");
    expect(job?.availableAt).toBe(future);
    expect(job?.dispatchRevision).toBe(1);
    expect(spy.calls).toHaveLength(0);

    const broken = createSnapshotFake();
    await seedPublication(broken, { availableAt: future });
    const failingOutbox: OutboxStore = {
      ...broken.outbox,
      async rearmCurrentJob(): Promise<never> {
        throw new Error("rearm store unavailable");
      },
    };
    expect(
      await executePublication(envelopeFor(), depsFor(broken, { outbox: failingOutbox })),
    ).toEqual({ kind: "infrastructure_retry", reason: "rearm_write_failed" });
  });

  it("settles a DLQ-seen due job through the DLQ path only", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const dlqSeen = viewStore(fake, (snapshot) => ({
      ...snapshot,
      job: {
        ...snapshot.job,
        dlqSeenAt: FIXTURE_NOW,
        transportReason: "queue_dlq" as typeof snapshot.job.transportReason,
      },
    }));
    const spy = publisherSpy("x-provider");

    expect(
      await executePublication(
        envelopeFor(),
        depsFor(fake, {
          publishing: dlqSeen,
          prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
        }),
      ),
    ).toEqual({ kind: "settled", reason: "dead_lettered" });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("dead_lettered");
    expect(publication?.errorAmbiguous).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  it("closes an exhausted attempt budget without a provider", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    // A job still marked attempt 4 for a publication at the cap.
    const exhausted = viewStore(fake, (snapshot) => ({
      ...snapshot,
      publication: { ...snapshot.publication, attempts: 3 },
      job: { ...snapshot.job, attemptNo: 3 },
    }));
    const spy = publisherSpy("x-provider");
    expect(
      await executePublication(
        envelopeFor(),
        depsFor(fake, {
          publishing: exhausted,
          prepare: async (platform) => readyPreparation(platform, { publisher: spy.publisher }),
        }),
      ),
    ).toEqual({ kind: "settled", reason: "pre_execution_rejected" });
    expect(fake.snapshot().publications[0]?.terminalReason).toBe("attempts_exhausted");
    // Closing the exhausted record consumes no further attempt.
    expect(fake.snapshot().publications[0]?.attempts).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("executePublication preparation and rejection", () => {
  it("defers temporary preparation failures and publishes nothing", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    let prepareCalls = 0;
    const throwing = depsFor(fake, {
      prepare: async () => {
        prepareCalls += 1;
        throw new Error("decrypt failed");
      },
    });
    expect(await executePublication(envelopeFor(), throwing)).toEqual({
      kind: "infrastructure_retry",
      reason: "preparation_deferred",
    });

    const spy = publisherSpy("x-provider");
    const unavailable = depsFor(fake, {
      prepare: async (platform) => blockedPreparation(platform, "unavailable"),
    });
    expect(await executePublication(envelopeFor(), unavailable)).toEqual({
      kind: "infrastructure_retry",
      reason: "preparation_deferred",
    });

    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("pending");
    expect(publication?.attempts).toBe(0);
    expect(publication?.claimToken).toBeNull();
    expect(prepareCalls).toBe(1);
    expect(spy.calls).toHaveLength(0);
  });

  it("rejects a permanently misconfigured or mis-bound publication as AUTH", async () => {
    const misconfigured = createSnapshotFake();
    await seedPublication(misconfigured);
    const spy = publisherSpy("x-provider");
    const blocked = depsFor(misconfigured, {
      prepare: async (platform) => blockedPreparation(platform, "missing_credentials"),
    });
    expect(await executePublication(envelopeFor(), blocked)).toEqual({
      kind: "settled",
      reason: "pre_execution_rejected",
    });
    let publication = misconfigured.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("invalid_configuration");
    expect(publication?.errorCode).toBe("AUTH");
    expect(publication?.errorAmbiguous).toBe(false);
    expect(publication?.attempts).toBe(0);
    expect(spy.calls).toHaveLength(0);

    const misbound = createSnapshotFake();
    const signer = testSigner();
    const binding = await computeCredentialBinding(bindingMaterialFor("x", "slot-a"), signer);
    await seedPublication(misbound, { binding });
    const replaced = depsFor(misbound, {
      signer,
      prepare: async (platform) =>
        readyPreparation(platform, { variant: "slot-b", publisher: spy.publisher }),
    });
    expect(await executePublication(envelopeFor(), replaced)).toEqual({
      kind: "settled",
      reason: "pre_execution_rejected",
    });
    publication = misbound.snapshot().publications[0];
    expect(publication?.terminalReason).toBe("binding_mismatch");
    expect(publication?.errorCode).toBe("AUTH");
    expect(spy.calls).toHaveLength(0);
  });

  it("rejects a missing binding before preparation or signing", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    let prepareCalls = 0;
    let signCalls = 0;
    const legacy = viewStore(fake, (snapshot) => ({
      ...snapshot,
      publication: { ...snapshot.publication, credentialBinding: null },
    }));
    const deps = depsFor(fake, {
      publishing: legacy,
      prepare: async (platform) => {
        prepareCalls += 1;
        return readyPreparation(platform);
      },
      signer: {
        async sign(): Promise<string> {
          signCalls += 1;
          throw new Error("signer must not run for an unbound record");
        },
      },
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "pre_execution_rejected",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.terminalReason).toBe("legacy_unbound");
    expect(publication?.errorCode).toBe("AUTH");
    expect(publication?.status).toBe("failed");
    expect(publication?.attempts).toBe(0);
    expect(prepareCalls).toBe(0);
    expect(signCalls).toBe(0);
  });

  it("allows the same connection after a slot revision advance", async () => {
    const fake = createSnapshotFake();
    const signer = testSigner();
    const variant = "slot-a";
    const binding = await computeCredentialBinding(bindingMaterialFor("x", variant), signer);
    await seedPublication(fake, { binding });
    for (let expected = 0; expected < 2; expected += 1) {
      const mutation = await fake.credentials.compareAndSetSlot({
        platform: "x",
        expectedRevision: expected,
        now: FIXTURE_NOW,
        change: {
          kind: "set",
          bindingId: `bind-${expected}`,
          envelope: testEnvelope(`slot-${expected}`),
          payloadRevision: expected + 1,
          payloadSchemaVersion: 1,
          expiresAt: null,
          target: null,
        },
      });
      expect(mutation.kind).toBe("applied");
    }

    const spy = publisherSpy("x-provider");
    const deps = depsFor(fake, {
      signer,
      prepare: async (platform) =>
        readyPreparation(platform, { variant, revision: 2, publisher: spy.publisher }),
    });
    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    expect(spy.calls).toHaveLength(1);
    expect(fake.snapshot().publications[0]?.status).toBe("published");
  });

  it("defers when the slot revision changed between preparation and claim", async () => {
    const fake = createSnapshotFake();
    const signer = testSigner();
    const binding = await computeCredentialBinding(bindingMaterialFor("x", "slot-a"), signer);
    await seedPublication(fake, { binding });
    const spy = publisherSpy("x-provider");
    const deps = depsFor(fake, {
      signer,
      // Preparation reports a revision no slot actually holds.
      prepare: async (platform) =>
        readyPreparation(platform, { variant: "slot-a", revision: 1, publisher: spy.publisher }),
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "infrastructure_retry",
      reason: "preparation_deferred",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("pending");
    expect(publication?.attempts).toBe(0);
    expect(publication?.claimToken).toBeNull();
    expect(spy.calls).toHaveLength(0);
  });

  it("never calls a provider when the claim result is unknown or throws", async () => {
    const unknown = createSnapshotFake();
    const unknownSetup = await boundSetup(unknown);
    unknown.faults.inject({ claimResultUnknownOnce: true });
    expect(await executePublication(envelopeFor(), unknownSetup.deps)).toEqual({
      kind: "infrastructure_retry",
      reason: "store_unavailable",
    });

    const throwing = createSnapshotFake();
    const brokenStore: PublishingStore = {
      ...throwing.publishing,
      async claimExecution(): Promise<never> {
        throw new Error("claim store unavailable");
      },
    };
    const throwingSetup = await boundSetup(throwing, undefined, { publishing: brokenStore });
    expect(await executePublication(envelopeFor(), throwingSetup.deps)).toEqual({
      kind: "infrastructure_retry",
      reason: "store_unavailable",
    });

    for (const fake of [unknown, throwing]) {
      expect(fake.snapshot().publications[0]?.attempts).toBe(0);
      expect(fake.snapshot().publications[0]?.claimToken).toBeNull();
    }
    expect(unknownSetup.spy.calls).toHaveLength(0);
    expect(throwingSetup.spy.calls).toHaveLength(0);
  });
});

describe("executePublication provider outcomes", () => {
  it("publishes once through the frozen provider and stores provider metadata", async () => {
    const fake = createSnapshotFake();
    const { spy, deps } = await boundSetup(fake, async () => ({
      externalId: "ext-9",
      externalUrl: "https://example.test/p/9",
    }));

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    expect(spy.calls).toEqual([
      { publicationId: PUBLICATION_ID, platform: "x", content: "hello syndroo" },
    ]);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.attempts).toBe(1);
    expect(publication?.claimToken).toBeNull();
    expect(publication?.externalId).toBe("ext-9");
    expect(publication?.externalUrl).toBe("https://example.test/p/9");
    expect(fake.snapshot().jobs[0]?.status).toBe("cancelled");
  });

  it("keeps a successful publish when provider metadata is hostile", async () => {
    const fake = createSnapshotFake();
    const sentinel = "SENTINEL-metadata-getter-13ab";
    const { deps } = await boundSetup(fake, async () => {
      const result: Record<string, unknown> = { externalUrl: "https://example.test/ok" };
      Object.defineProperty(result, "externalId", {
        configurable: true,
        get(): never {
          throw new Error(`metadata leak ${sentinel}`);
        },
      });
      return result as PublishResult;
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.externalId).toBeNull();
    expect(JSON.stringify(publication)).not.toContain(sentinel);
  });

  it("retries the identical local write after a transient commit failure", async () => {
    const fake = createSnapshotFake();
    const { spy, deps } = await boundSetup(fake);
    fake.faults.inject({ failNextCommitAfterStage: new Error("lost acknowledgement") });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    expect(spy.calls).toHaveLength(1);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.attempts).toBe(1);
  });

  it("never republishes when the outcome write keeps failing or conflicts", async () => {
    const failing = createSnapshotFake();
    const brokenCommit: PublishingStore = {
      ...failing.publishing,
      async commitExecution(): Promise<never> {
        throw new Error("commit store unavailable");
      },
    };
    const failingSetup = await boundSetup(failing, undefined, { publishing: brokenCommit });
    expect(await executePublication(envelopeFor(), failingSetup.deps)).toEqual({
      kind: "infrastructure_retry",
      reason: "store_unavailable",
    });
    expect(failingSetup.spy.calls).toHaveLength(1);
    expect(failing.snapshot().publications[0]?.status).toBe("publishing");
    expect(failing.snapshot().publications[0]?.claimToken).toBe("claim_1");

    // A duplicate for the same attempt settles on the live claim instead of
    // publishing a second time.
    expect(await executePublication(envelopeFor(), failingSetup.deps)).toEqual({
      kind: "settled",
      reason: "duplicate",
    });
    expect(failingSetup.spy.calls).toHaveLength(1);

    const conflicting = createSnapshotFake();
    const conflictStore: PublishingStore = {
      ...conflicting.publishing,
      async commitExecution() {
        return commitConflict("guard_mismatch");
      },
    };
    const conflictSetup = await boundSetup(conflicting, undefined, { publishing: conflictStore });
    expect(await executePublication(envelopeFor(), conflictSetup.deps)).toEqual({
      kind: "settled",
      reason: "duplicate",
    });
    expect(conflictSetup.spy.calls).toHaveLength(1);
    expect(conflicting.snapshot().publications[0]?.status).toBe("publishing");
  });

  it("schedules 60s and 120s business retries, then closes the exhausted budget", async () => {
    const fake = createSnapshotFake();
    const signer = testSigner();
    const binding = await computeCredentialBinding(bindingMaterialFor("x", "slot-a"), signer);
    await seedPublication(fake, { binding });
    let now = FIXTURE_NOW;
    const spy = publisherSpy("x-provider", async () => {
      throw new PublishError("rate limited", "RATE_LIMIT", false);
    });
    const deps = depsFor(fake, {
      signer,
      clock: { now: () => now },
      prepare: async (platform) =>
        readyPreparation(platform, { variant: "slot-a", publisher: spy.publisher }),
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    let publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("pending");
    expect(publication?.retryAt).toBe(instant(60_000));
    expect(publication?.errorCode).toBe("RATE_LIMIT");
    expect(publication?.errorAmbiguous).toBe(false);
    const secondJobId = publication?.currentJobId ?? "";
    expect(secondJobId).toBe("job_1");
    expect(fake.snapshot().jobs.find((job) => job.id === secondJobId)?.availableAt).toBe(
      instant(60_000),
    );
    expect(fake.snapshot().jobs.find((job) => job.id === JOB_ID)?.status).toBe("cancelled");

    now = instant(60_000);
    expect(await executePublication(envelopeFor(PUBLICATION_ID, secondJobId), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    publication = fake.snapshot().publications[0];
    // The second delay counts from the second attempt's own completion time.
    expect(publication?.retryAt).toBe(instant(180_000));
    const thirdJobId = publication?.currentJobId ?? "";
    expect(fake.snapshot().jobs.find((job) => job.id === thirdJobId)?.attemptNo).toBe(3);

    now = instant(180_000);
    expect(await executePublication(envelopeFor(PUBLICATION_ID, thirdJobId), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("attempts_exhausted");
    expect(publication?.errorAmbiguous).toBe(false);
    expect(spy.calls).toHaveLength(3);
    expect(fake.snapshot().jobs).toHaveLength(3);
  });

  it("bases the business retry on a fresh completion time, not on queue start", async () => {
    const fake = createSnapshotFake();
    const signer = testSigner();
    const binding = await computeCredentialBinding(bindingMaterialFor("x", "slot-a"), signer);
    await seedPublication(fake, { binding });
    const stepMs = 30_000;
    let reads = 0;
    const clock = {
      now: (): string => {
        const value = instant(stepMs * reads);
        reads += 1;
        return value;
      },
    };
    const spy = publisherSpy("x-provider", async () => {
      throw new PublishError("rate limited", "RATE_LIMIT", false);
    });
    const deps = depsFor(fake, {
      signer,
      clock,
      prepare: async (platform) =>
        readyPreparation(platform, { variant: "slot-a", publisher: spy.publisher }),
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    const retryAt = publication?.retryAt ?? FIXTURE_NOW;
    // A slow prepare/provider must not shorten the 60s delay: the base is the
    // frozen completion time, which the advancing clock puts well after entry.
    expect(Date.parse(retryAt) - Date.parse(FIXTURE_NOW)).toBeGreaterThan(60_000);
    expect(publication?.updatedAt).toBe(
      new Date(Date.parse(retryAt) - 60_000).toISOString(),
    );
  });

  it("preserves a valid later retry hint end to end", async () => {
    const fake = createSnapshotFake();
    const hint = instant(3 * 24 * 60 * 60_000);
    const { deps } = await boundSetup(fake, async () => {
      throw new PublishError("rate limited", "RATE_LIMIT", false, { retryAfterAt: hint });
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.retryAt).toBe(hint);
    const nextJob = fake.snapshot().jobs.find((job) => job.id === publication?.currentJobId);
    expect(nextJob?.availableAt).toBe(hint);
  });

  it("closes ambiguous, unknown and malformed failures without retrying", async () => {
    const sentinel = "SENTINEL-provider-payload-7c40";
    const cases: readonly {
      readonly label: string;
      readonly failure: () => Promise<never>;
      readonly code: PublishErrorCode | null;
    }[] = [
      {
        label: "typed ambiguous",
        failure: async () => {
          throw new PublishError("network reset", "NETWORK", true);
        },
        code: "NETWORK",
      },
      {
        label: "generic throw",
        failure: async () => {
          throw new Error(`unexpected failure ${sentinel}`);
        },
        code: "UNKNOWN",
      },
      {
        label: "typed unknown with a false flag",
        failure: async () => {
          throw new PublishError("unknown", "UNKNOWN", false);
        },
        code: "UNKNOWN",
      },
      {
        label: "forged code and flag",
        failure: async () => {
          throw new PublishError(
            "forged",
            "BOGUS" as unknown as PublishErrorCode,
            "yes" as unknown as boolean,
          );
        },
        code: "UNKNOWN",
      },
      {
        label: "throwing getter",
        failure: async () => {
          const hostile = new PublishError("safe", "RATE_LIMIT", false);
          Object.defineProperty(hostile, "ambiguous", {
            configurable: true,
            get(): never {
              throw new Error(`getter leak ${sentinel}`);
            },
          });
          throw hostile;
        },
        code: "UNKNOWN",
      },
    ];

    for (const entry of cases) {
      const fake = createSnapshotFake();
      const spy = publisherSpy("x-provider", entry.failure);
      const signer = testSigner();
      const binding = await computeCredentialBinding(bindingMaterialFor("x", "slot-a"), signer);
      await seedPublication(fake, { binding });
      const logger = collectingLogger();
      const deps = depsFor(fake, {
        signer,
        logger: logger.logger,
        archive: fake.archive,
        prepare: async (platform) =>
          readyPreparation(platform, { variant: "slot-a", publisher: spy.publisher }),
      });

      expect(await executePublication(envelopeFor(), deps)).toEqual({
        kind: "settled",
        reason: "executed",
      });
      const publication = fake.snapshot().publications[0];
      expect(publication?.status, entry.label).toBe("failed");
      expect(publication?.terminalReason, entry.label).toBe("unknown");
      expect(publication?.errorAmbiguous, entry.label).toBe(true);
      if (entry.code !== null) {
        expect(publication?.errorCode, entry.label).toBe(entry.code);
      }
      // No retry intent and exactly one provider call.
      expect(spy.calls, entry.label).toHaveLength(1);
      expect(fake.snapshot().jobs, entry.label).toHaveLength(1);
      expect(JSON.stringify(fake.snapshot()), entry.label).not.toContain(sentinel);
      expect(JSON.stringify(logger.events), entry.label).not.toContain(sentinel);
    }
  });

  it("rejects an unambiguous non-safe provider code without retrying", async () => {
    const fake = createSnapshotFake();
    const { spy, deps } = await boundSetup(fake, async () => {
      throw new PublishError("invalid content", "INVALID_CONTENT", false);
    });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("provider_rejected");
    expect(publication?.errorCode).toBe("INVALID_CONTENT");
    expect(publication?.errorAmbiguous).toBe(false);
    expect(spy.calls).toHaveLength(1);
    expect(fake.snapshot().jobs).toHaveLength(1);
  });
});

async function outwardDump(
  fake: SnapshotFake,
  events: readonly SafeLogEvent[],
): Promise<string> {
  const snapshot = fake.snapshot();
  const payloads: unknown[] = [];
  for (const key of snapshot.archives) {
    payloads.push(await fake.archive.get(key));
  }
  return JSON.stringify({
    posts: snapshot.posts,
    publications: snapshot.publications,
    jobs: snapshot.jobs,
    logs: events,
    archives: payloads,
  });
}

describe("executePublication archive", () => {
  it("archives an allowlisted diagnostic after the outcome commit", async () => {
    const fake = createSnapshotFake();
    const { deps } = await boundSetup(fake, undefined, { archive: fake.archive });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.archiveStatus).toBe("available");
    const key = publication?.archiveKey;
    expect(key).toBe("archive/provider-responses/2026/09/pub_exec1/attempt_1.json");
    const payload = key === null || key === undefined ? null : await fake.archive.get(key);
    expect(payload).not.toBeNull();
    expect(payload?.outcome).toBe("published");
    expect(payload?.code).toBe(null);
    expect(payload?.httpStatus).toBe(null);
    expect(payload?.attemptId).toBe("attempt_1");
    expect(payload?.expiresAt).toBe(instant(30 * 24 * 60 * 60_000));
    expect(() => assertSanitizedArchive(payload)).not.toThrow();
  });

  it("records a failed archive without changing the publishing outcome", async () => {
    const fake = createSnapshotFake();
    const rejecting: ArchiveStore = {
      async put(): Promise<void> {
        throw new Error("r2 unavailable");
      },
      async get() {
        return null;
      },
      async delete(): Promise<void> {},
    };
    const { deps } = await boundSetup(fake, undefined, { archive: rejecting });

    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.archiveStatus).toBe("failed");
  });

  it("bounds a hanging archive object write inside the total budget", async () => {
    const fake = createSnapshotFake();
    const hanging: ArchiveStore = {
      async put(): Promise<void> {
        await new Promise<void>(() => {});
      },
      async get() {
        return null;
      },
      async delete(): Promise<void> {},
    };
    const { deps } = await boundSetup(fake, undefined, {
      archive: hanging,
      archiveBudgetMs: 40,
    });

    const startedAt = Date.now();
    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.archiveStatus).toBe("unavailable");
  });

  it("bounds a hanging archive status write without losing the outcome", async () => {
    const fake = createSnapshotFake();
    const hangingStatus: PublishingStore = {
      ...fake.publishing,
      async recordArchiveResult(): Promise<CommitResult> {
        await new Promise<void>(() => {});
        throw new Error("unreachable");
      },
    };
    const { deps } = await boundSetup(fake, undefined, {
      publishing: hangingStatus,
      archive: fake.archive,
      archiveBudgetMs: 40,
    });

    const startedAt = Date.now();
    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    // The object write completed, so `available` is reported; the diagnostic
    // status row simply never landed.
    expect(publication?.archiveStatus).toBe("pending");
  });

  it("finishes the archive stage exactly at the requested total budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(new Date(Date.parse(FIXTURE_NOW)));
      const hangingArchive: ArchiveStore = {
        async put(): Promise<void> {
          await new Promise<void>(() => {});
        },
        async get() {
          return null;
        },
        async delete(): Promise<void> {},
      };
      const hangingStatus: Pick<PublishingStore, "recordArchiveResult"> = {
        async recordArchiveResult(): Promise<CommitResult> {
          await new Promise<void>(() => {});
          throw new Error("unreachable");
        },
      };
      const plan = planArchive({
        now: FIXTURE_NOW,
        publicationId: "pub_1",
        jobId: "job_1",
        attemptId: "attempt_1",
        platform: "x",
        outcome: "published",
        code: null,
        httpStatus: null,
      });

      const startedAt = Date.now();
      let status: string | null = null;
      void writeArchiveBestEffort({
        archive: hangingArchive,
        publishing: hangingStatus,
        publicationId: "pub_1",
        jobId: "job_1",
        attemptId: "attempt_1",
        plan,
        now: FIXTURE_NOW,
        budgetMs: 1000,
      }).then((value) => {
        status = value;
      });

      // Object write slice: 1000 - 250 reserved = 750ms.
      await vi.advanceTimersByTimeAsync(749);
      expect(status).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(status).toBeNull();
      // Reserved marking slice inside the same total budget.
      await vi.advanceTimersByTimeAsync(250);
      expect(status).toBe("unavailable");
      expect(Date.now() - startedAt).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pretend to archive when no archive binding is injected", async () => {
    const fake = createSnapshotFake();
    const { deps } = await boundSetup(fake);
    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.archiveKey).toBeNull();
    expect(publication?.archiveStatus).toBe("not_requested");
    expect(fake.snapshot().archives).toEqual([]);
  });

  it("keeps the outcome when the archive logger throws", async () => {
    const fake = createSnapshotFake();
    const logger: Logger = {
      write(): void {
        throw new Error("logger exploded");
      },
    };
    const { deps } = await boundSetup(fake, undefined, { archive: fake.archive, logger });
    expect(await executePublication(envelopeFor(), deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("published");
    expect(publication?.archiveStatus).toBe("available");
  });

  it("keeps secrets out of records, logs and archive objects", async () => {
    const sentinel = "SENTINEL-execution-secret-2b7d";
    const events = collectingLogger();

    const preparation = createSnapshotFake();
    const failingPrepare = await boundSetup(preparation, undefined, {
      logger: events.logger,
      archive: preparation.archive,
      prepare: async () => {
        throw new Error(`decrypt leak ${sentinel}`);
      },
    });
    expect(await executePublication(envelopeFor(), failingPrepare.deps)).toEqual({
      kind: "infrastructure_retry",
      reason: "preparation_deferred",
    });

    const provider = createSnapshotFake();
    const providerSetup = await boundSetup(
      provider,
      async () => {
        throw new Error(`provider leak ${sentinel}`);
      },
      { logger: events.logger, archive: provider.archive },
    );
    expect(await executePublication(envelopeFor(), providerSetup.deps)).toEqual({
      kind: "settled",
      reason: "executed",
    });

    expect(await outwardDump(preparation, events.events)).not.toContain(sentinel);
    expect(await outwardDump(provider, events.events)).not.toContain(sentinel);
  });
});
