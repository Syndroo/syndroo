import { describe, expect, it } from "vitest";

import type {
  CreatePostInput,
  Platform,
  Publisher,
  PublishRequest,
  PublishResult,
} from "@syndroo/core";

import {
  InvalidContractInputError,
  StoreUnavailable,
  computeCredentialBinding,
  encodeBindingMaterial,
  type BindingMaterial,
  type BindingSigner,
  type Logger,
  type OutboxStore,
  type PublisherBlockReason,
  type PublisherPreparation,
  type SafeLogEvent,
  type SafePlatformStatus,
} from "../src/index.js";
import { createPost, type CreatePostDependencies } from "../src/use-cases/create-post.js";
import { dispatchReadyJobs } from "../src/use-cases/dispatch-ready-jobs.js";
import {
  PublishingUseCaseError,
  type UseCaseClock,
  type UseCaseIdFactory,
} from "../src/use-cases/shared.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  createTransaction,
  instant,
  testEnvelope,
  type SnapshotFake,
} from "../src/testing/index.js";

/** Real WebCrypto HMAC so the signing path is exercised, not simulated. */
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

function bindingMaterialFor(platform: Platform, slotBindingId: string | null): BindingMaterial {
  return encodeBindingMaterial({
    platform,
    source: slotBindingId === null ? "env" : "credential",
    fields: [
      ["slotBinding", slotBindingId],
      ["X_API_KEY", "test-key"],
    ],
  });
}

function stubPublisher(platform: Platform): Publisher {
  return {
    name: `${platform}-provider`,
    async publish(request: PublishRequest): Promise<PublishResult> {
      return { externalId: `${request.publicationId}-external` };
    },
  };
}

function readyFor(
  platform: Platform,
  revision = 0,
  slotBindingId: string | null = null,
): PublisherPreparation {
  const source = slotBindingId === null ? "env" : "credential";
  const status: SafePlatformStatus = {
    platform,
    configured: true,
    source,
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
      publisher: stubPublisher(platform),
      status,
      target: null,
      slotBindingId,
      bindingMaterial: bindingMaterialFor(platform, slotBindingId),
      credentialRevision: revision,
      credentialSource: source,
    },
  };
}

function blockedFor(platform: Platform, missingField: string): PublisherPreparation {
  const status: SafePlatformStatus = {
    platform,
    configured: false,
    source: null,
    oauthSupported: false,
    readiness: "missing_credentials",
    missingFields: [missingField],
    expiresAt: null,
    revision: 0,
  };
  return {
    kind: "blocked",
    reason: "missing_credentials",
    status,
    readiness: "missing_credentials",
    missingFields: [missingField],
  };
}

function counterIds(): UseCaseIdFactory {
  const counts = new Map<string, number>();
  return (kind) => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return `${kind}_${next}`;
  };
}

/**
 * One identity stream per fake store, so repeated `depsFor` calls in a test
 * keep generating fresh IDs instead of colliding with rows already committed.
 */
const idStreams = new WeakMap<SnapshotFake, UseCaseIdFactory>();

function idsFor(fake: SnapshotFake): UseCaseIdFactory {
  const existing = idStreams.get(fake);
  if (existing !== undefined) {
    return existing;
  }
  const created = counterIds();
  idStreams.set(fake, created);
  return created;
}

const FIXED_CLOCK: UseCaseClock = { now: () => FIXTURE_NOW };

interface DependencyOverrides {
  readonly prepare?: CreatePostDependencies["prepare"];
  readonly signer?: BindingSigner;
  readonly outbox?: OutboxStore;
  readonly queue?: CreatePostDependencies["queue"];
  readonly clock?: UseCaseClock;
  readonly ids?: UseCaseIdFactory;
  readonly logger?: Logger;
  readonly shouldContinueDispatch?: () => boolean;
  readonly dispatchLimit?: number;
}

function depsFor(
  fake: SnapshotFake,
  overrides: DependencyOverrides = {},
): CreatePostDependencies {
  return {
    publishing: fake.publishing,
    outbox: overrides.outbox ?? fake.outbox,
    queue: overrides.queue ?? fake.queue,
    signer: overrides.signer ?? testSigner(),
    prepare: overrides.prepare ?? (async (platform) => readyFor(platform)),
    clock: overrides.clock ?? FIXED_CLOCK,
    ids: overrides.ids ?? idsFor(fake),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    ...(overrides.shouldContinueDispatch === undefined
      ? {}
      : { shouldContinueDispatch: overrides.shouldContinueDispatch }),
    ...(overrides.dispatchLimit === undefined ? {} : { dispatchLimit: overrides.dispatchLimit }),
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

/** Bounded description of an error for secret-leak assertions. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...Object.fromEntries(Object.entries(error)),
  });
}

describe("createPost structural validation", () => {
  it("rejects invalid structural input and keys before any database read", async () => {
    const fake = createSnapshotFake();
    const prepareCalls: string[] = [];
    const deps = depsFor(fake, {
      prepare: async (platform) => {
        prepareCalls.push(platform);
        return readyFor(platform);
      },
    });
    const before = fake.snapshot();

    const cases: readonly { readonly input: CreatePostInput; readonly reason: string }[] = [
      { input: { content: "   ", platforms: ["x"] }, reason: "content" },
      { input: { content: "ok", platforms: [] }, reason: "platforms" },
      { input: { content: "ok", platforms: ["x", "x"] }, reason: "platforms" },
      { input: { content: "ok", platforms: ["facebook"] as unknown as Platform[] }, reason: "platforms" },
      {
        input: { content: "ok", platforms: ["x"], overrides: { bluesky: { content: "no" } } },
        reason: "overrides",
      },
      {
        input: { content: "ok", platforms: ["x"], scheduledAt: "2026-09-23T09:00:00+09:00" },
        reason: "scheduled_at",
      },
    ];

    for (const entry of cases) {
      await expect(createPost(entry.input, deps, "key-structural")).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        reason: entry.reason,
      });
    }
    await expect(
      createPost({ content: "ok", platforms: ["x"] }, deps, "not a valid key"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", reason: "idempotency_key" });

    expect(prepareCalls).toEqual([]);
    expect(fake.snapshot()).toEqual(before);
    expect(fake.sentEnvelopes).toEqual([]);
  });

  it("accepts a known but uninstalled platform structurally and fails in preparation", async () => {
    const fake = createSnapshotFake();
    const deps = depsFor(fake, {
      prepare: async (platform) => blockedFor(platform, "NOSTR_PRIVATE_KEY"),
    });
    await expect(createPost({ content: "ok", platforms: ["nostr"] }, deps)).rejects.toMatchObject({
      code: "PUBLISHER_PREPARATION_BLOCKED",
      reason: "missing_credentials",
    });
    expect(fake.snapshot().posts).toHaveLength(0);
  });
});

describe("createPost idempotency", () => {
  it("replays an accepted request before prepare, signing or readiness", async () => {
    const fake = createSnapshotFake();
    const input: CreatePostInput = { content: "hello", platforms: ["x"] };
    const first = await createPost(input, depsFor(fake), "key-replay");
    expect(first.replayed).toBe(false);
    expect(first.status).toBe("queued");

    let prepareCalls = 0;
    let signCalls = 0;
    let queueCalls = 0;
    let clockCalls = 0;
    const hostile = depsFor(fake, {
      prepare: async () => {
        prepareCalls += 1;
        throw new Error("preparation must not run on replay");
      },
      signer: {
        async sign(): Promise<string> {
          signCalls += 1;
          throw new Error("signing must not run on replay");
        },
      },
      clock: {
        now: (): never => {
          clockCalls += 1;
          throw new Error("the clock must not be read on replay");
        },
      },
      queue: {
        async send(): Promise<void> {
          queueCalls += 1;
          throw new Error("the queue must not be used on replay");
        },
      },
      outbox: {
        ...fake.outbox,
        async listReady(): Promise<never> {
          throw new Error("the outbox must not be read on replay");
        },
      },
      // A replay must not even require a valid dispatch budget.
      dispatchLimit: 0,
    });

    const replay = await createPost(input, hostile, "key-replay");
    expect(replay.replayed).toBe(true);
    expect(replay.postId).toBe(first.postId);
    expect(replay.status).toBe("queued");
    expect(replay.enqueueDeferred).toBe(false);
    expect(replay.dispatch).toEqual({
      examined: 0,
      sent: 0,
      dispatched: 0,
      markFailed: 0,
      sendFailed: 0,
      sendUnknown: 0,
      unstarted: 0,
      confirmedJobIds: [],
    });
    expect(prepareCalls).toBe(0);
    expect(signCalls).toBe(0);
    expect(queueCalls).toBe(0);
    expect(clockCalls).toBe(0);
    expect(fake.snapshot().posts).toHaveLength(1);
  });

  it("uses the injected clock for a new create and rejects a non-canonical one", async () => {
    const fake = createSnapshotFake();
    const later = instant(60_000);
    const result = await createPost(
      { content: "clocked", platforms: ["x"] },
      depsFor(fake, { clock: { now: () => later } }),
      "key-clock",
    );
    expect(result.status).toBe("queued");
    expect(result.scheduledAt).toBeNull();
    const snapshot = fake.snapshot();
    expect(snapshot.posts[0]?.createdAt).toBe(later);
    expect(snapshot.publications[0]?.createdAt).toBe(later);
    expect(snapshot.jobs[0]?.availableAt).toBe(later);
    expect(snapshot.sentEnvelopes[0]?.enqueuedAt).toBe(later);

    const broken = createSnapshotFake();
    await expect(
      createPost(
        { content: "clocked", platforms: ["x"] },
        depsFor(broken, { clock: { now: () => "2026-09-23T09:00:00+09:00" } }),
        "key-clock-broken",
      ),
    ).rejects.toThrow("clock must return a canonical UTC instant");
    expect(broken.snapshot().posts).toHaveLength(0);
    expect(broken.sentEnvelopes).toHaveLength(0);
  });

  it("compares requests canonically and rejects a different request under the same key", async () => {
    const fake = createSnapshotFake();
    await createPost({ content: "first", platforms: ["x"] }, depsFor(fake), "key-conflict");

    let prepareCalls = 0;
    const deps = depsFor(fake, {
      prepare: async (platform) => {
        prepareCalls += 1;
        return readyFor(platform);
      },
    });
    await expect(
      createPost({ content: "second", platforms: ["x"] }, deps, "key-conflict"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(prepareCalls).toBe(0);
    expect(fake.snapshot().posts).toHaveLength(1);

    // A different override set is a different request too.
    await expect(
      createPost(
        { content: "first", platforms: ["x"], overrides: { x: { content: "changed" } } },
        deps,
        "key-conflict",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("replays a platform-order-insensitive request and creates without a key", async () => {
    const fake = createSnapshotFake();
    const deps = depsFor(fake);
    const first = await createPost(
      { content: "ordered", platforms: ["x", "bluesky"], overrides: { x: { content: "ordered-x" } } },
      deps,
      "key-order",
    );
    const replay = await createPost(
      { content: "ordered", platforms: ["bluesky", "x"], overrides: { x: { content: "ordered-x" } } },
      deps,
      "key-order",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.postId).toBe(first.postId);
    expect(fake.snapshot().posts).toHaveLength(1);

    const one = await createPost({ content: "no key", platforms: ["x"] }, deps);
    const two = await createPost({ content: "no key", platforms: ["x"] }, deps);
    expect(one.replayed).toBe(false);
    expect(two.replayed).toBe(false);
    expect(one.postId).not.toBe(two.postId);
    expect(fake.snapshot().posts).toHaveLength(3);
  });

  it("applies the same comparison when a concurrent create commits first", async () => {
    const fake = createSnapshotFake();
    const deps = depsFor(fake);
    const input: CreatePostInput = { content: "concurrent", platforms: ["x", "bluesky"] };
    const results = await Promise.all([
      createPost(input, deps, "key-concurrent"),
      createPost(input, deps, "key-concurrent"),
    ]);

    const snapshot = fake.snapshot();
    expect(snapshot.posts).toHaveLength(1);
    expect(snapshot.publications).toHaveLength(2);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.postId)).size).toBe(1);
    expect(snapshot.publications.every((publication) => publication.status === "pending")).toBe(
      true,
    );
    // Duplicate dispatch is permitted (the consumer CAS is the de-duplicator);
    // what must not happen is a second Post.
    expect(new Set(fake.sentEnvelopes.map((envelope) => envelope.jobId)).size).toBe(2);
  });

  it("snapshots the caller's intent before the first awaited fingerprint", async () => {
    const fake = createSnapshotFake();
    const input: CreatePostInput = {
      content: "original",
      platforms: ["x"],
      overrides: { x: { content: "original-x" } },
    };
    const pending = createPost(input, depsFor(fake), "key-immutable");

    // Mutate the caller's object while the use case is suspended.
    input.content = "mutated";
    input.platforms.push("bluesky");
    (input.overrides?.x ?? {}).content = "mutated-x";

    const result = await pending;
    expect(result.replayed).toBe(false);
    const snapshot = fake.snapshot();
    const post = snapshot.posts[0];
    expect(post?.content).toBe("original");
    expect(post?.platforms).toEqual(["x"]);
    expect(post?.overrides).toEqual({ x: { content: "original-x" } });
    expect(snapshot.publications.map((publication) => publication.content)).toEqual([
      "original-x",
    ]);

    const replay = await createPost(
      { content: "original", platforms: ["x"], overrides: { x: { content: "original-x" } } },
      depsFor(fake),
      "key-immutable",
    );
    expect(replay.replayed).toBe(true);
    await expect(createPost(input, depsFor(fake), "key-immutable")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("snapshots overrides so a strategy cannot rewrite committed content", async () => {
    const fake = createSnapshotFake();
    const overrides: Record<string, { content?: string }> = { x: { content: "before" } };
    const deps = depsFor(fake, {
      prepare: async (platform) => {
        overrides["x"] = { content: "after" };
        return readyFor(platform);
      },
    });
    await createPost({ content: "base", platforms: ["x"], overrides }, deps, "key-override");
    expect(fake.snapshot().publications[0]?.content).toBe("before");
  });
});

describe("createPost guards, scheduling and preparation", () => {
  it("preserves schedule intent and per-platform override content", async () => {
    const fake = createSnapshotFake();
    const immediate = await createPost(
      { content: "base", platforms: ["x", "bluesky"], overrides: { x: { content: "override" } } },
      depsFor(fake),
      "key-due",
    );
    expect(immediate.status).toBe("queued");
    expect(immediate.enqueueDeferred).toBe(false);
    expect(immediate.dispatch.dispatched).toBe(2);

    const snapshot = fake.snapshot();
    expect(snapshot.posts[0]?.status).toBe("queued");
    expect(
      snapshot.publications.map((publication) => [
        publication.platform,
        publication.status,
        publication.content,
      ]),
    ).toEqual([
      ["x", "pending", "override"],
      ["bluesky", "pending", "base"],
    ]);
    expect(
      snapshot.jobs.map((job) => [job.availableAt, job.status, job.attemptNo]),
    ).toEqual([
      [FIXTURE_NOW, "dispatched", 1],
      [FIXTURE_NOW, "dispatched", 1],
    ]);
    expect(snapshot.sentEnvelopes).toHaveLength(2);

    const future = instant(3_600_000);
    const later = await createPost(
      { content: "later", platforms: ["x"], scheduledAt: future },
      depsFor(fake),
      "key-future",
    );
    expect(later.status).toBe("scheduled");
    expect(later.dispatch.examined).toBe(0);
    const afterFuture = fake.snapshot();
    const scheduledPost = afterFuture.posts.find((post) => post.id === later.postId);
    const scheduledPublication = afterFuture.publications.find(
      (publication) => publication.postId === later.postId,
    );
    const scheduledJob = afterFuture.jobs.find(
      (job) => job.aggregateId === scheduledPublication?.id,
    );
    expect(scheduledPost?.status).toBe("scheduled");
    expect(scheduledPost?.scheduledAt).toBe(future);
    expect(scheduledPublication?.status).toBe("scheduled");
    expect(scheduledJob?.availableAt).toBe(future);
    expect(scheduledJob?.status).toBe("pending");
    expect(afterFuture.sentEnvelopes).toHaveLength(2);

    const past = instant(-60_000);
    const due = await createPost(
      { content: "past", platforms: ["x"], scheduledAt: past },
      depsFor(fake),
      "key-past",
    );
    expect(due.status).toBe("queued");
    expect(due.dispatch.dispatched).toBe(1);
    const afterPast = fake.snapshot();
    const pastPost = afterPast.posts.find((post) => post.id === due.postId);
    const pastPublication = afterPast.publications.find(
      (publication) => publication.postId === due.postId,
    );
    const pastJob = afterPast.jobs.find((job) => job.aggregateId === pastPublication?.id);
    expect(pastPost?.scheduledAt).toBe(past);
    expect(pastPublication?.status).toBe("pending");
    expect(pastJob?.availableAt).toBe(FIXTURE_NOW);
  });

  it("records the prepared provider, revision, slot binding and HMAC", async () => {
    const fake = createSnapshotFake();
    await fake.credentials.compareAndSetSlot({
      platform: "x",
      expectedRevision: 0,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-slot",
        envelope: testEnvelope("one"),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });
    const signer = testSigner();
    const deps = depsFor(fake, {
      signer,
      prepare: async (platform) => readyFor(platform, 1, "bind-slot"),
    });
    const result = await createPost({ content: "bound", platforms: ["x"] }, deps, "key-binding");

    const publication = fake.snapshot().publications[0];
    expect(publication?.provider).toBe("x-provider");
    expect(publication?.credentialRevisionAtCreate).toBe(1);
    expect(publication?.credentialBinding).toBe(
      await computeCredentialBinding(bindingMaterialFor("x", "bind-slot"), signer),
    );
    expect(result.dispatch.dispatched).toBe(1);
  });

  it("treats a slot guard conflict as a safe conflict with zero sends", async () => {
    const fake = createSnapshotFake();
    await fake.credentials.compareAndSetSlot({
      platform: "x",
      expectedRevision: 0,
      now: FIXTURE_NOW,
      change: {
        kind: "set",
        bindingId: "bind-slot",
        envelope: testEnvelope("one"),
        payloadRevision: 1,
        payloadSchemaVersion: 1,
        expiresAt: null,
        target: null,
      },
    });

    const staleRevision = depsFor(fake, { prepare: async (platform) => readyFor(platform, 0) });
    await expect(
      createPost({ content: "stale", platforms: ["x"] }, staleRevision, "key-guard-1"),
    ).rejects.toMatchObject({
      code: "CREATE_CONFLICT",
      reason: "credential_revision_mismatch",
    });

    const otherBinding = depsFor(fake, {
      prepare: async (platform) => readyFor(platform, 1, "bind-other"),
    });
    await expect(
      createPost({ content: "stale", platforms: ["x"] }, otherBinding, "key-guard-2"),
    ).rejects.toMatchObject({
      code: "CREATE_CONFLICT",
      reason: "credential_revision_mismatch",
    });

    const snapshot = fake.snapshot();
    expect(snapshot.posts).toHaveLength(0);
    expect(snapshot.publications).toHaveLength(0);
    expect(snapshot.jobs).toHaveLength(0);
    expect(fake.sentEnvelopes).toHaveLength(0);
  });

  it("fails closed on a blocked preparation without writing or leaking fields", async () => {
    const fake = createSnapshotFake();
    const sentinel = "SENTINEL-missing-field-3f9a";
    const deps = depsFor(fake, {
      prepare: async (platform) =>
        platform === "x" ? readyFor("x") : blockedFor(platform, sentinel),
    });

    let caught: unknown;
    await createPost({ content: "blocked", platforms: ["x", "linkedin"] }, deps, "key-blocked").catch(
      (error: unknown) => {
        caught = error;
      },
    );

    expect(caught).toBeInstanceOf(PublishingUseCaseError);
    const error = caught as PublishingUseCaseError;
    expect(error.code).toBe("PUBLISHER_PREPARATION_BLOCKED");
    expect(error.reason).toBe("missing_credentials");
    expect(describeError(error)).not.toContain(sentinel);
    const snapshot = fake.snapshot();
    expect(snapshot.posts).toHaveLength(0);
    expect(snapshot.publications).toHaveLength(0);
    expect(fake.sentEnvelopes).toHaveLength(0);
  });

  it("never echoes raw strategy failure text", async () => {
    const fake = createSnapshotFake();
    const sentinel = "SENTINEL-strategy-failure-77c1";
    const deps = depsFor(fake, {
      prepare: async () => {
        throw new Error(`strategy blew up: ${sentinel}`);
      },
    });

    let caught: unknown;
    await createPost({ content: "boom", platforms: ["x"] }, deps).catch((error: unknown) => {
      caught = error;
    });
    expect(caught).toBeInstanceOf(PublishingUseCaseError);
    expect((caught as PublishingUseCaseError).code).toBe("PUBLISHER_PREPARATION_BLOCKED");
    expect((caught as PublishingUseCaseError).reason).toBe("unavailable");
    expect(describeError(caught)).not.toContain(sentinel);
    expect(fake.snapshot().posts).toHaveLength(0);
  });

  it("never trusts an injected error class, even a subclass carrying a sentinel", async () => {
    const fake = createSnapshotFake();
    const sentinel = "SENTINEL-forged-class-4d21";

    class Forged extends InvalidContractInputError {
      public constructor() {
        super(`forged contract failure: ${sentinel}`, { cause: new Error(sentinel) });
        this.name = "InvalidContractInputError";
      }
    }

    const forgedSigner: BindingSigner = {
      async sign(): Promise<string> {
        throw new Forged();
      },
    };
    const cases: readonly {
      readonly deps: CreatePostDependencies;
      readonly code: string;
      readonly reason: string;
    }[] = [
      {
        deps: depsFor(fake, {
          prepare: async () => {
            throw new Forged();
          },
        }),
        code: "PUBLISHER_PREPARATION_BLOCKED",
        reason: "invalid_configuration",
      },
      {
        deps: depsFor(fake, { signer: forgedSigner }),
        // A binding-key failure is instance-wide, not a platform readiness result.
        code: "INSTANCE_NOT_READY",
        reason: "invalid_configuration",
      },
    ];

    for (const entry of cases) {
      let caught: unknown;
      await createPost({ content: "forged", platforms: ["x"] }, entry.deps).catch(
        (error: unknown) => {
          caught = error;
        },
      );
      const error = caught as PublishingUseCaseError;
      expect(error).toBeInstanceOf(PublishingUseCaseError);
      expect(error.code).toBe(entry.code);
      expect(error.reason).toBe(entry.reason);
      expect(error.cause).toBeUndefined();
      expect(describeError(error)).not.toContain(sentinel);
    }

    // A forged block reason is allowlisted too, so it cannot smuggle free text.
    let blockedCaught: unknown;
    await createPost(
      { content: "forged", platforms: ["x"] },
      depsFor(fake, {
        prepare: async (platform) => ({
          kind: "blocked",
          reason: sentinel as unknown as PublisherBlockReason,
          readiness: "unavailable",
          missingFields: [sentinel],
          status: {
            platform,
            configured: false,
            source: null,
            oauthSupported: false,
            readiness: "unavailable",
            missingFields: [sentinel],
            expiresAt: null,
            revision: 0,
          },
        }),
      }),
    ).catch((error: unknown) => {
      blockedCaught = error;
    });
    const blocked = blockedCaught as PublishingUseCaseError;
    expect(blocked.code).toBe("PUBLISHER_PREPARATION_BLOCKED");
    expect(blocked.reason).toBe("unavailable");
    expect(describeError(blocked)).not.toContain(sentinel);
    expect(fake.snapshot().posts).toHaveLength(0);
  });

  it("preserves only a classified instance error from preparation", async () => {
    const fake = createSnapshotFake();
    const sentinel = "SENTINEL-forged-instance-91be";

    class ForgedInstance extends PublishingUseCaseError {
      public constructor() {
        super("INSTANCE_NOT_READY", "invalid_configuration");
        this.message = `forged instance failure: ${sentinel}`;
      }
    }

    let instanceCaught: unknown;
    await createPost(
      { content: "instance", platforms: ["x"] },
      depsFor(fake, {
        prepare: async () => {
          throw new ForgedInstance();
        },
      }),
    ).catch((error: unknown) => {
      instanceCaught = error;
    });
    const instanceError = instanceCaught as PublishingUseCaseError;
    expect(instanceError.code).toBe("INSTANCE_NOT_READY");
    expect(instanceError.reason).toBe("invalid_configuration");
    expect(instanceError.message).toBe("the publishing instance is not ready");
    expect(describeError(instanceError)).not.toContain(sentinel);

    // An unrelated code thrown by preparation is re-derived as platform
    // readiness instead of being trusted.
    let unrelatedCaught: unknown;
    await createPost(
      { content: "unrelated", platforms: ["x"] },
      depsFor(fake, {
        prepare: async () => {
          throw new PublishingUseCaseError("INVALID_REQUEST", "content");
        },
      }),
    ).catch((error: unknown) => {
      unrelatedCaught = error;
    });
    const unrelated = unrelatedCaught as PublishingUseCaseError;
    expect(unrelated.code).toBe("PUBLISHER_PREPARATION_BLOCKED");
    expect(unrelated.reason).toBe("unavailable");
    expect(fake.snapshot().posts).toHaveLength(0);
  });

  it("reports deferred when an accepted send loses its dispatch mark", async () => {
    const fake = createSnapshotFake();
    fake.faults.inject({ failNextDispatchRecordAfterStage: new Error("mark lost") });
    const result = await createPost(
      { content: "mark", platforms: ["x"] },
      depsFor(fake),
      "key-mark",
    );

    expect(result.enqueueDeferred).toBe(true);
    expect(result.dispatch.sent).toBe(1);
    expect(result.dispatch.dispatched).toBe(0);
    expect(result.dispatch.markFailed).toBe(1);
    expect(fake.sentEnvelopes).toHaveLength(1);
    expect(fake.snapshot().jobs[0]?.status).toBe("pending");
  });

  it("reports deferred when an older backlog consumes the fast-path budget", async () => {
    const fake = createSnapshotFake();
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await fake.publishing.createPostWithDispatch(
        createTransaction({
          key: null,
          postId: `post_back${suffix}`,
          platforms: ["x"],
          publicationIds: [`pub_back${suffix}`],
          jobIds: [`job_back${suffix}`],
        }),
      );
    }

    // Keep the new identity sorting after the backlog so the tick cap really
    // excludes it, exactly as a busy production wake can.
    const result = await createPost(
      { content: "newest", platforms: ["x"] },
      depsFor(fake, {
        ids: (kind) =>
          kind === "post" ? "post_newest" : kind === "publication" ? "pub_newest" : "job_newest",
      }),
      "key-backlog",
    );

    expect(result.enqueueDeferred).toBe(true);
    const snapshot = fake.snapshot();
    const publication = snapshot.publications.find((row) => row.postId === result.postId);
    const job = snapshot.jobs.find((row) => row.aggregateId === publication?.id);
    expect(job?.status).toBe("pending");
    expect(result.dispatch.examined).toBe(20);
    expect(result.dispatch.confirmedJobIds).not.toContain(job?.id);
    expect(fake.sentEnvelopes).toHaveLength(20);

    // The later routine wake drains the backlog and the new job.
    const wake = await dispatchReadyJobs({
      outbox: fake.outbox,
      queue: fake.queue,
      now: FIXTURE_NOW,
    });
    expect(wake.dispatched).toBe(6);
    expect(wake.confirmedJobIds).toContain(job?.id);
    expect(
      fake.snapshot().jobs.every((row) => row.status === "dispatched"),
    ).toBe(true);
  });

  it("keeps the accepted create when the fast-path dispatch fails", async () => {
    const fake = createSnapshotFake();
    const { logger, events } = collectingLogger();
    const brokenOutbox: OutboxStore = {
      ...fake.outbox,
      async listReady(): Promise<never> {
        throw new StoreUnavailable("store down");
      },
    };
    const result = await createPost(
      { content: "deferred", platforms: ["x"] },
      depsFor(fake, { outbox: brokenOutbox, logger }),
      "key-deferred",
    );

    expect(result.enqueueDeferred).toBe(true);
    expect(result.dispatch).toEqual({
      examined: 0,
      sent: 0,
      dispatched: 0,
      markFailed: 0,
      sendFailed: 0,
      sendUnknown: 0,
      unstarted: 0,
      confirmedJobIds: [],
    });
    const snapshot = fake.snapshot();
    expect(snapshot.posts).toHaveLength(1);
    expect(snapshot.jobs[0]?.status).toBe("pending");
    expect(fake.sentEnvelopes).toHaveLength(0);
    expect(events.map((event) => event.event)).toEqual(["post_dispatch_deferred"]);
  });

  it("rejects a wiring-level dispatch limit before committing", async () => {
    const fake = createSnapshotFake();
    await expect(
      createPost(
        { content: "limit", platforms: ["x"] },
        depsFor(fake, { dispatchLimit: 0 }),
        "key-limit",
      ),
    ).rejects.toThrow("dispatch limit must be a positive safe integer");
    expect(fake.snapshot().posts).toHaveLength(0);
  });
});
