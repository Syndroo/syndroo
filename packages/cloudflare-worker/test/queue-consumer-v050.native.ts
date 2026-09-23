/**
 * Native Queue/DLQ mapping conformance (Task 5c).
 *
 * Runs only under `test/queue-consumer-v050.vitest.config.ts`, which fails
 * closed on any outbound request and discovers exactly this file. The accepted
 * portable use cases run against the frozen snapshot fake with a counted
 * provider; no broker, account or provider request is made.
 *
 * The mapping is proven at the disposition level: `createMessageBatch` /
 * `getQueueResult` for the native ack/retry results, plus a structural batch
 * whose `ack`/`retry` record their order for the quarantine-before-ack and
 * single-disposition proofs.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PublishError, type Publisher, type PublishRequest, type PublishResult } from "@syndroo/core";

import {
  StoreUnavailable,
  encodeBindingMaterial,
  type BindingSigner,
  type ConsumerOutcome,
  type PublisherPreparation,
  type SafePlatformStatus,
} from "@syndroo/application";
import { FIXTURE_NOW, createSnapshotFake, createTransaction, instant } from "@syndroo/application/testing";

import {
  QueueConsumerError,
  RETRY_DELAY_SECONDS,
  createQueueConsumer,
  type QueueConsumer,
  type QueueConsumerDependencies,
  type QueueConsumerNames,
  type QuarantineAlertEvent,
} from "../src/composition/queue-consumer.js";

const MAIN_QUEUE = "syndroo-publications-v050";
const DEAD_LETTER_QUEUE = "syndroo-publications-v050-dlq";
const BINDING = `v1:${"a".repeat(64)}`;
const SENTINEL = "SENTINEL-queue-mapping-7c31";

function errorText(error: unknown): string {
  return error instanceof Error
    ? JSON.stringify({ name: error.name, message: error.message, stack: error.stack })
    : String(error);
}

/** Deterministic signer: the mapping never inspects the digest itself. */
const SIGNER: BindingSigner = {
  async sign(): Promise<string> {
    return "a".repeat(64);
  },
};

interface PublisherSpy {
  readonly publisher: Publisher;
  readonly calls: PublishRequest[];
}

function publisherSpy(
  behaviour: (request: PublishRequest) => Promise<PublishResult> = async () => ({
    externalId: "ext-1",
  }),
): PublisherSpy {
  const calls: PublishRequest[] = [];
  return {
    calls,
    publisher: {
      name: "x-provider",
      async publish(request: PublishRequest): Promise<PublishResult> {
        calls.push(request);
        return behaviour(request);
      },
    },
  };
}

function readyPreparation(platform: "x" | "bluesky", publisher: Publisher): PublisherPreparation {
  const status: SafePlatformStatus = {
    platform,
    configured: true,
    source: "env",
    oauthSupported: false,
    readiness: "ready",
    missingFields: [],
    expiresAt: null,
    revision: 0,
  };
  return {
    kind: "ready",
    prepared: {
      platform,
      publisher,
      status,
      target: null,
      slotBindingId: null,
      bindingMaterial: encodeBindingMaterial({
        platform,
        source: "env",
        fields: [
          ["slotBinding", null],
          ["X_API_KEY", "fixture-key"],
        ],
      }),
      credentialRevision: 0,
      credentialSource: "env",
    },
  };
}

interface SeededPublication {
  readonly publicationId: string;
  readonly jobId: string;
}

async function seedPublication(
  fake: ReturnType<typeof createSnapshotFake>,
  options: {
    readonly suffix: string;
    readonly availableAt?: string;
    readonly content?: string;
  },
): Promise<SeededPublication> {
  const publicationId = `pub_${options.suffix}`;
  const jobId = `job_${options.suffix}`;
  const content = options.content ?? `content ${options.suffix}`;
  await fake.publishing.createPostWithDispatch({
    scope: "posts.create.v1",
    idempotencyKey: null,
    requestFingerprint: `fingerprint-${options.suffix}`,
    now: FIXTURE_NOW,
    post: {
      id: `post_${options.suffix}`,
      content,
      platforms: ["x"],
      overrides: {},
      scheduledAt: null,
      status: "queued",
      createdAt: FIXTURE_NOW,
    },
    publications: [
      {
        id: publicationId,
        postId: `post_${options.suffix}`,
        platform: "x",
        provider: "x-provider",
        content,
        status: "pending",
        scheduledAt: null,
        credentialBinding: BINDING,
        credentialRevision: 0,
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
    credentialGuards: [{ platform: "x", expectedRevision: 0, bindingId: null }],
  });
  return { publicationId, jobId };
}

function envelopeBody(publicationId: string, jobId: string): unknown {
  return {
    version: 1,
    jobId,
    kind: "delivery.execute",
    entityId: publicationId,
    enqueuedAt: FIXTURE_NOW,
  };
}

interface AlertRecorder {
  readonly events: QuarantineAlertEvent[];
  readonly sink: (event: QuarantineAlertEvent) => void;
}

function alertRecorder(options: { readonly fail?: Error } = {}): AlertRecorder {
  const events: QuarantineAlertEvent[] = [];
  return {
    events,
    sink: (event: QuarantineAlertEvent): void => {
      events.push(event);
      if (options.fail !== undefined) {
        throw options.fail;
      }
    },
  };
}

interface ConsumerHarness {
  readonly consumer: QueueConsumer;
  readonly spy: PublisherSpy;
  readonly alerts: AlertRecorder;
  readonly fake: ReturnType<typeof createSnapshotFake>;
}

function harness(
  options: {
    readonly names?: QueueConsumerDependencies["names"];
    readonly provider?: (request: PublishRequest) => Promise<PublishResult>;
    readonly alert?: (event: QuarantineAlertEvent) => void;
    readonly clock?: { now(): string };
  } = {},
): ConsumerHarness {
  const fake = createSnapshotFake();
  const spy = publisherSpy(options.provider);
  const alerts = alertRecorder();
  const consumer = createQueueConsumer({
    names: options.names ?? { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
    execute: {
      publishing: fake.publishing,
      outbox: fake.outbox,
      prepare: async (platform) => readyPreparation(platform as "x" | "bluesky", spy.publisher),
      signer: SIGNER,
      clock: options.clock ?? { now: () => FIXTURE_NOW },
      ids: (kind) => `${kind}_${crypto.randomUUID()}`,
    },
    settleDeadLetter: {
      publishing: fake.publishing,
      clock: options.clock ?? { now: () => FIXTURE_NOW },
    },
    alert: options.alert ?? alerts.sink,
  });
  return { consumer, spy, alerts, fake };
}

interface StructuralBatch {
  readonly batch: MessageBatch<unknown>;
  readonly order: string[];
  readonly retryDelays: (number | undefined)[];
}

interface ForbiddenDomain {
  readonly execute: QueueConsumerDependencies["execute"];
  readonly settleDeadLetter: QueueConsumerDependencies["settleDeadLetter"];
  readonly alert: QueueConsumerDependencies["alert"];
}

/**
 * Every semantic method counts its call and throws. Used where the correct
 * behaviour is "no domain work at all", so any touch is both observable in the
 * returned counter list and impossible to mistake for a passing assertion.
 */
function forbiddenDomain(calls: string[]): ForbiddenDomain {
  const bump = (name: string): never => {
    calls.push(name);
    throw new Error(`unexpected ${name} ${SENTINEL}`);
  };
  const publishing = {
    findIdempotentPost: async () => bump("findIdempotentPost"),
    createPostWithDispatch: async () => bump("createPostWithDispatch"),
    getExecution: async () => bump("getExecution"),
    claimExecution: async () => bump("claimExecution"),
    commitExecution: async () => bump("commitExecution"),
    rejectBeforeExecution: async () => bump("rejectBeforeExecution"),
    settleDeadLetter: async () => bump("settleDeadLetter"),
    recoverStaleClaims: async () => bump("recoverStaleClaims"),
    recordArchiveResult: async () => bump("recordArchiveResult"),
  } as unknown as QueueConsumerDependencies["execute"]["publishing"];
  const outbox = {
    listReady: async () => bump("listReady"),
    recordDispatch: async () => bump("recordDispatch"),
    rearmCurrentJob: async () => bump("rearmCurrentJob"),
    collectFinished: async () => bump("collectFinished"),
  } as unknown as QueueConsumerDependencies["execute"]["outbox"];

  return {
    execute: {
      publishing,
      outbox,
      prepare: (async () => bump("prepare")) as unknown as QueueConsumerDependencies["execute"]["prepare"],
      signer: { async sign(): Promise<string> { return bump("sign"); } },
      clock: {
        now(): string {
          return bump("clock");
        },
      },
      ids: (kind) => {
        calls.push(`id:${kind}`);
        return `${kind}_forbidden`;
      },
    },
    settleDeadLetter: {
      publishing: publishing as unknown as QueueConsumerDependencies["settleDeadLetter"]["publishing"],
      clock: {
        now(): string {
          return bump("clock");
        },
      },
    },
    alert: (): void => {
      bump("alert");
    },
  };
}

/** Structural MessageBatch: records disposition order for ordering proofs. */
function structuralBatch(
  queueName: string,
  bodies: readonly unknown[],
  options: { readonly ackThrows?: Error; readonly retryThrows?: Error } = {},
): StructuralBatch {
  const order: string[] = [];
  const retryDelays: (number | undefined)[] = [];
  const messages = bodies.map((body, index) => ({
    id: `msg_${index}`,
    timestamp: new Date(FIXTURE_NOW),
    attempts: 1,
    body,
    ack: (): void => {
      order.push(`ack:${index}`);
      if (options.ackThrows !== undefined) {
        throw options.ackThrows;
      }
    },
    retry: (retryOptions?: { readonly delaySeconds?: number }): void => {
      order.push(`retry:${index}`);
      retryDelays.push(retryOptions?.delaySeconds);
      if (options.retryThrows !== undefined) {
        throw options.retryThrows;
      }
    },
  }));
  return {
    order,
    retryDelays,
    batch: {
      queue: queueName,
      messages,
      ackAll: (): void => undefined,
      retryAll: (): void => undefined,
    } as unknown as MessageBatch<unknown>,
  };
}

describe("queue routing validation", () => {
  it("rejects missing, empty, equal or whitespace names and a missing sink", () => {
    const cases: readonly unknown[] = [
      undefined,
      { main: MAIN_QUEUE },
      { main: "", deadLetter: DEAD_LETTER_QUEUE },
      { main: "   ", deadLetter: DEAD_LETTER_QUEUE },
      { main: MAIN_QUEUE, deadLetter: "" },
      { main: MAIN_QUEUE, deadLetter: MAIN_QUEUE },
    ];
    for (const names of cases) {
      let caught: unknown;
      try {
        createQueueConsumer({
          names: names as QueueConsumerDependencies["names"],
          // Routing validation must fail before these are ever touched.
          execute: {} as never,
          settleDeadLetter: {} as never,
          alert: alertRecorder().sink,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QueueConsumerError);
      expect((caught as QueueConsumerError).code).toBe("QUEUE_ROUTING_INVALID");
      expect(errorText(caught)).not.toContain(MAIN_QUEUE);
      expect(errorText(caught)).not.toContain(SENTINEL);
    }

    // A missing alert sink cannot satisfy the quarantine contract.
    let sinkError: unknown;
    try {
      createQueueConsumer({
        names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
        execute: {} as never,
        settleDeadLetter: {} as never,
        alert: undefined as never,
      });
    } catch (error) {
      sinkError = error;
    }
    expect(sinkError).toBeInstanceOf(QueueConsumerError);
    expect((sinkError as QueueConsumerError).code).toBe("QUEUE_ROUTING_INVALID");
  });
});

interface DispositionView {
  readonly acks: readonly string[];
  /** Retry message ids as reported by the native queue result. */
  readonly retryIds: readonly string[];
}

async function dispositions(
  consumer: QueueConsumer,
  queueName: string,
  bodies: readonly unknown[],
): Promise<DispositionView | null> {
  const batch = createMessageBatch<unknown>(
    queueName,
    bodies.map((body, index) => ({
      id: `msg_${index}`,
      timestamp: new Date(FIXTURE_NOW),
      attempts: 1,
      body,
    })),
  );
  const context = createExecutionContext();
  try {
    await consumer(batch as unknown as MessageBatch<unknown>);
  } catch (error) {
    if (!(error instanceof QueueConsumerError)) {
      throw error;
    }
  }
  try {
    const result = (await getQueueResult(batch, context)) as {
      explicitAcks?: readonly string[];
      retryMessages?: readonly { readonly msgId?: string }[];
    };
    return {
      acks: result.explicitAcks ?? [],
      retryIds: (result.retryMessages ?? []).map((retry) => retry.msgId ?? ""),
    };
  } catch {
    // A batch that was never fully disposed has no queue result to read.
    return null;
  }
}

describe("batch routing", () => {
  it("performs no domain work or disposition for unknown, prefixed or missing queue names", async () => {
    const cases: readonly string[] = [
      "syndroo-publications-v050-old",
      "syndroo-publications-v050-extra",
      "syndroo-publications",
      "other-queue",
    ];

    for (const queueName of cases) {
      // Every semantic method counts and throws, so any domain touch would be
      // both visible and loud; nothing needs a nullable result read.
      const calls: string[] = [];
      const forbidden = forbiddenDomain(calls);
      const structural = structuralBatch(queueName, [envelopeBody("pub_x", "job_x")]);
      const consumer = createQueueConsumer({
        names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
        execute: forbidden.execute,
        settleDeadLetter: forbidden.settleDeadLetter,
        alert: forbidden.alert,
      });

      let caught: unknown;
      await consumer(structural.batch).catch((error: unknown) => {
        caught = error;
      });

      expect(caught, queueName).toBeInstanceOf(QueueConsumerError);
      expect((caught as QueueConsumerError).code, queueName).toBe("QUEUE_ROUTING_INVALID");
      expect(errorText(caught), queueName).not.toContain(queueName);
      expect(errorText(caught), queueName).not.toContain(SENTINEL);
      expect(calls, queueName).toEqual([]);
      expect(structural.order, queueName).toEqual([]);
      expect(structural.retryDelays, queueName).toEqual([]);
    }

    // The same fixed error is produced by a real native MessageBatch.
    const nativeCalls: string[] = [];
    const nativeForbidden = forbiddenDomain(nativeCalls);
    const nativeConsumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: nativeForbidden.execute,
      settleDeadLetter: nativeForbidden.settleDeadLetter,
      alert: nativeForbidden.alert,
    });
    const nativeBatch = createMessageBatch<unknown>("other-queue", [
      {
        id: "msg_0",
        timestamp: new Date(FIXTURE_NOW),
        attempts: 1,
        body: envelopeBody("pub_x", "job_x"),
      },
    ]);
    let nativeError: unknown;
    await nativeConsumer(nativeBatch as unknown as MessageBatch<unknown>).catch(
      (error: unknown) => {
        nativeError = error;
      },
    );
    expect(nativeError).toBeInstanceOf(QueueConsumerError);
    expect((nativeError as QueueConsumerError).code).toBe("QUEUE_ROUTING_INVALID");
    expect(nativeCalls).toEqual([]);
  });

  it("copies the physical names once and never re-reads the caller's object", async () => {
    let mainReads = 0;
    let deadLetterReads = 0;
    const names: QueueConsumerNames = {
      get main(): string {
        mainReads += 1;
        return MAIN_QUEUE;
      },
      get deadLetter(): string {
        deadLetterReads += 1;
        return DEAD_LETTER_QUEUE;
      },
    };
    const { consumer } = harness({ names });
    expect(mainReads).toBe(1);
    expect(deadLetterReads).toBe(1);

    const view = await dispositions(consumer, MAIN_QUEUE, ["not-an-envelope"]);
    expect(view?.retryIds).toEqual(["msg_0"]);
    expect(mainReads).toBe(1);
    expect(deadLetterReads).toBe(1);
  });

  it("fails a hostile batch shape with the fixed routing error and no domain work", async () => {
    const hostile = (queueName: string): MessageBatch<unknown> =>
      ({
        queue: queueName,
        get messages(): never {
          throw new Error(`hostile messages getter ${SENTINEL}`);
        },
      }) as unknown as MessageBatch<unknown>;

    for (const queueName of ["other-queue", MAIN_QUEUE, DEAD_LETTER_QUEUE]) {
      const { consumer, spy, fake, alerts } = harness();
      const seeded = await seedPublication(fake, { suffix: "hostile" });
      const before = fake.snapshot();

      let caught: unknown;
      await consumer(hostile(queueName)).catch((error: unknown) => {
        caught = error;
      });

      expect(caught, queueName).toBeInstanceOf(QueueConsumerError);
      expect((caught as QueueConsumerError).code, queueName).toBe("QUEUE_ROUTING_INVALID");
      expect(errorText(caught), queueName).not.toContain(SENTINEL);
      expect(spy.calls, queueName).toHaveLength(0);
      expect(alerts.events, queueName).toEqual([]);
      expect(fake.snapshot(), queueName).toEqual(before);
      void seeded;
    }
  });
});

describe("main queue mapping", () => {
  it("retries a malformed message once with the fixed delay and no provider call", async () => {
    const { consumer, spy, fake } = harness();
    const view = await dispositions(consumer, MAIN_QUEUE, ["not-an-envelope"]);

    expect(view?.acks).toEqual([]);
    expect(view?.retryIds).toEqual(["msg_0"]);
    expect(spy.calls).toHaveLength(0);
    expect(fake.snapshot().publications).toEqual([]);

    // The fixed sixty-second delay itself, recorded at the disposition call.
    const structural = structuralBatch(MAIN_QUEUE, ["not-an-envelope"]);
    await consumer(structural.batch);
    expect(structural.order).toEqual(["retry:0"]);
    expect(structural.retryDelays).toEqual([RETRY_DELAY_SECONDS]);
  });

  it("acknowledges a settled execution and never resends duplicates or terminal work", async () => {
    const { consumer, spy, fake } = harness();
    const seeded = await seedPublication(fake, { suffix: "main1" });
    const body = envelopeBody(seeded.publicationId, seeded.jobId);

    const first = await dispositions(consumer, MAIN_QUEUE, [body]);
    expect(first?.acks).toEqual(["msg_0"]);
    expect(first?.retryIds).toEqual([]);
    expect(spy.calls).toHaveLength(1);
    const published = fake.snapshot().publications[0];
    expect(published?.status).toBe("published");

    // Duplicate delivery of the same message: terminal publication, no resend.
    const duplicate = await dispositions(consumer, MAIN_QUEUE, [body]);
    expect(duplicate?.acks).toEqual(["msg_0"]);
    expect(spy.calls).toHaveLength(1);
  });

  it("acknowledges future and unknown work without sending anything", async () => {
    const { consumer, spy, fake } = harness();
    const future = await seedPublication(fake, {
      suffix: "future1",
      availableAt: instant(600_000),
    });

    const futureView = await dispositions(consumer, MAIN_QUEUE, [
      envelopeBody(future.publicationId, future.jobId),
    ]);
    expect(futureView?.acks).toEqual(["msg_0"]);
    expect(spy.calls).toHaveLength(0);
    expect(fake.snapshot().jobs[0]?.status).toBe("pending");

    const unknownView = await dispositions(consumer, MAIN_QUEUE, [
      envelopeBody("pub_missing", "job_missing"),
    ]);
    expect(unknownView?.acks).toEqual(["msg_0"]);
    expect(spy.calls).toHaveLength(0);
  });

  it("acknowledges a business retry without turning it into a broker retry", async () => {
    const { consumer, spy, fake } = harness({
      provider: async () => {
        throw new PublishError("rate limited", "RATE_LIMIT", false);
      },
    });
    const seeded = await seedPublication(fake, { suffix: "business1" });

    const view = await dispositions(consumer, MAIN_QUEUE, [
      envelopeBody(seeded.publicationId, seeded.jobId),
    ]);

    expect(view?.acks).toEqual(["msg_0"]);
    expect(view?.retryIds).toEqual([]);
    expect(spy.calls).toHaveLength(1);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("pending");
    expect(publication?.retryAt).toBe(instant(60_000));
    expect(publication?.currentJobId).not.toBe(seeded.jobId);
  });

  it("maps an unexpected use-case exception to one fixed retry", async () => {
    const { consumer, spy, fake } = harness({
      clock: {
        now(): string {
          throw new Error(`clock exploded ${SENTINEL}`);
        },
      },
    });
    const seeded = await seedPublication(fake, { suffix: "unexpected1" });

    const view = await dispositions(consumer, MAIN_QUEUE, [
      envelopeBody(seeded.publicationId, seeded.jobId),
    ]);

    expect(view?.acks).toEqual([]);
    expect(view?.retryIds).toEqual(["msg_0"]);
    expect(spy.calls).toHaveLength(0);
    expect(JSON.stringify(view)).not.toContain(SENTINEL);

    const structural = structuralBatch(MAIN_QUEUE, [
      envelopeBody(seeded.publicationId, seeded.jobId),
    ]);
    await consumer(structural.batch);
    expect(structural.order).toEqual(["retry:0"]);
    expect(structural.retryDelays).toEqual([RETRY_DELAY_SECONDS]);
  });

  it("processes several messages sequentially with one disposition each", async () => {
    const fake = createSnapshotFake();
    const first = await seedPublication(fake, { suffix: "seq1" });
    const second = await seedPublication(fake, { suffix: "seq2" });
    const spy = publisherSpy();
    const structural = structuralBatch(MAIN_QUEUE, [
      envelopeBody(first.publicationId, first.jobId),
      envelopeBody(second.publicationId, second.jobId),
    ]);
    const started: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {
        publishing: fake.publishing,
        outbox: fake.outbox,
        prepare: async (platform) => {
          started.push(`prepare:${started.length}`);
          if (started.length === 1) {
            // Hold the first message inside preparation.
            await new Promise<void>((resolve) => {
              releaseFirst = () => {
                started.push("first-released");
                resolve();
              };
            });
          }
          return readyPreparation(platform as "x" | "bluesky", spy.publisher);
        },
        signer: SIGNER,
        clock: { now: () => FIXTURE_NOW },
        ids: (kind) => `${kind}_${crypto.randomUUID()}`,
      },
      settleDeadLetter: { publishing: fake.publishing, clock: { now: () => FIXTURE_NOW } },
      alert: alertRecorder().sink,
    });

    const running = consumer(structural.batch);
    // While the first message runs: the second has not started, no provider ran,
    // and nothing has been acknowledged.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(["prepare:0"]);
    expect(spy.calls).toHaveLength(0);
    expect(structural.order).toEqual([]);
    releaseFirst!();
    await running;

    expect(started).toEqual(["prepare:0", "first-released", "prepare:2"]);
    expect(structural.order).toEqual(["ack:0", "ack:1"]);
    expect(structural.retryDelays).toEqual([]);
    expect(spy.calls).toHaveLength(2);
    expect(
      fake.snapshot().publications.map((publication) => publication.status),
    ).toEqual(["published", "published"]);
  });
});

describe("dead-letter queue mapping", () => {
  it("acknowledges a settled DLQ message after metadata settlement", async () => {
    const fake = createSnapshotFake();
    const seeded = await seedPublication(fake, { suffix: "dlq1" });
    const alerts = alertRecorder();
    const structural = structuralBatch(DEAD_LETTER_QUEUE, [
      envelopeBody(seeded.publicationId, seeded.jobId),
    ]);
    const realSettle = fake.publishing.settleDeadLetter.bind(fake.publishing);
    let releaseSettle: (() => void) | null = null;
    let settleCalls = 0;
    let prepareCalls = 0;
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {
        publishing: fake.publishing,
        outbox: fake.outbox,
        prepare: async (platform) => {
          // Any preparation would be the gateway to a provider call.
          prepareCalls += 1;
          return readyPreparation(platform as "x" | "bluesky", publisherSpy().publisher);
        },
        signer: SIGNER,
        clock: { now: () => FIXTURE_NOW },
        ids: (kind) => `${kind}_dlq`,
      },
      settleDeadLetter: {
        publishing: {
          ...fake.publishing,
          async settleDeadLetter(input): Promise<Awaited<ReturnType<typeof realSettle>>> {
            settleCalls += 1;
            structural.order.push("settle-start");
            await new Promise<void>((resolve) => {
              releaseSettle = () => resolve();
            });
            const outcome = await realSettle(input);
            structural.order.push("settle-end");
            return outcome;
          },
        },
        clock: { now: () => FIXTURE_NOW },
      },
      alert: alerts.sink,
    });

    const running = consumer(structural.batch);
    // While the authoritative settlement is pending: no disposition at all, and
    // the publication has not been changed by this wake.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(structural.order).toEqual(["settle-start"]);
    expect(structural.retryDelays).toEqual([]);
    expect(fake.snapshot().publications[0]?.status).toBe("pending");
    releaseSettle!();
    await running;

    expect(structural.order).toEqual(["settle-start", "settle-end", "ack:0"]);
    expect(settleCalls).toBe(1);
    expect(prepareCalls).toBe(0);
    expect(alerts.events).toEqual([]);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("dead_lettered");
  });

  it("emits the fixed alert before acknowledging a quarantined message", async () => {
    const fake = createSnapshotFake();
    const recorded: QuarantineAlertEvent[] = [];
    const structural = structuralBatch(DEAD_LETTER_QUEUE, [
      { publicationId: `pub_${SENTINEL}`, jobId: `job_${SENTINEL}`, body: SENTINEL },
    ]);
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {} as never,
      settleDeadLetter: { publishing: fake.publishing, clock: { now: () => FIXTURE_NOW } },
      alert: (event: QuarantineAlertEvent): void => {
        // One shared order log proves the alert completed before the ack.
        structural.order.push("alert");
        recorded.push(event);
      },
    });
    const before = fake.snapshot();

    await consumer(structural.batch);

    expect(structural.order).toEqual(["alert", "ack:0"]);
    expect(recorded).toEqual([{ code: "MALFORMED_DLQ_MESSAGE" }]);
    expect(Object.isFrozen(recorded[0])).toBe(true);
    expect(JSON.stringify(structural.order)).not.toContain(SENTINEL);
    expect(JSON.stringify(recorded)).not.toContain(SENTINEL);
    expect(fake.snapshot()).toEqual(before);
  });

  it("acknowledges a malformed DLQ message after the alert in a native batch", async () => {
    const { consumer, alerts, fake } = harness();
    const before = fake.snapshot();

    const view = await dispositions(consumer, DEAD_LETTER_QUEUE, [
      { publicationId: "legacy-publication", credential: SENTINEL },
    ]);

    expect(view?.acks).toEqual(["msg_0"]);
    expect(view?.retryIds).toEqual([]);
    expect(alerts.events).toEqual([{ code: "MALFORMED_DLQ_MESSAGE" }]);
    expect(fake.snapshot()).toEqual(before);
  });

  it("retries without acknowledging when the quarantine alert throws", async () => {
    const fake = createSnapshotFake();
    const alertError = new Error(`alert sink failed ${SENTINEL}`);
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {} as never,
      settleDeadLetter: { publishing: fake.publishing, clock: { now: () => FIXTURE_NOW } },
      alert: (): void => {
        throw alertError;
      },
    });

    // Native result: one fixed retry, no ack.
    const native = await dispositions(consumer, DEAD_LETTER_QUEUE, ["malformed"]);
    expect(native?.acks).toEqual([]);
    expect(native?.retryIds).toEqual(["msg_0"]);

    // Structural result: no acknowledgement was even attempted.
    const structural = structuralBatch(DEAD_LETTER_QUEUE, ["malformed"]);
    await consumer(structural.batch);
    expect(structural.order).toEqual(["retry:0"]);
    expect(structural.retryDelays).toEqual([RETRY_DELAY_SECONDS]);
    expect(fake.snapshot().publications).toEqual([]);
    expect(errorText(alertError)).toContain(SENTINEL);
  });

  it("retries a store failure without alerting", async () => {
    const fake = createSnapshotFake();
    const failing = {
      ...fake.publishing,
      async settleDeadLetter(): Promise<never> {
        throw new StoreUnavailable(`settlement failed ${SENTINEL}`);
      },
    };
    const alerts = alertRecorder();
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {} as never,
      settleDeadLetter: { publishing: failing, clock: { now: () => FIXTURE_NOW } },
      alert: alerts.sink,
    });
    const seeded = await seedPublication(fake, { suffix: "dlqfail" });

    const view = await dispositions(consumer, DEAD_LETTER_QUEUE, [
      envelopeBody(seeded.publicationId, seeded.jobId),
    ]);

    expect(view?.acks).toEqual([]);
    expect(view?.retryIds).toEqual(["msg_0"]);
    expect(alerts.events).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(SENTINEL);

    const structural = structuralBatch(DEAD_LETTER_QUEUE, [
      envelopeBody(seeded.publicationId, seeded.jobId),
    ]);
    await consumer(structural.batch);
    expect(structural.order).toEqual(["retry:0"]);
    expect(structural.retryDelays).toEqual([RETRY_DELAY_SECONDS]);
  });

  it("waits for an asynchronous alert to complete before acknowledging", async () => {
    const fake = createSnapshotFake();
    const structural = structuralBatch(DEAD_LETTER_QUEUE, ["malformed"]);
    let releaseAlert: (() => void) | null = null;
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {} as never,
      settleDeadLetter: { publishing: fake.publishing, clock: { now: () => FIXTURE_NOW } },
      alert: (): Promise<void> => {
        // One shared order log: alert completion and the ack are comparable.
        structural.order.push("alert-start");
        return new Promise<void>((resolve) => {
          releaseAlert = () => {
            structural.order.push("alert-end");
            resolve();
          };
        });
      },
    });

    const running = consumer(structural.batch);
    // While the alert is still pending there is no acknowledgement and no retry.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(structural.order).toEqual(["alert-start"]);
    expect(structural.retryDelays).toEqual([]);
    releaseAlert!();
    await running;

    expect(structural.order).toEqual(["alert-start", "alert-end", "ack:0"]);

    // The native result after completion records exactly one acknowledgement.
    const nativeConsumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {} as never,
      settleDeadLetter: { publishing: fake.publishing, clock: { now: () => FIXTURE_NOW } },
      alert: async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    const native = await dispositions(nativeConsumer, DEAD_LETTER_QUEUE, ["malformed"]);
    expect(native?.acks).toEqual(["msg_0"]);
    expect(native?.retryIds).toEqual([]);
  });

  it("retries without acknowledging when an asynchronous alert rejects", async () => {
    const fake = createSnapshotFake();
    const consumer = createQueueConsumer({
      names: { main: MAIN_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
      execute: {} as never,
      settleDeadLetter: { publishing: fake.publishing, clock: { now: () => FIXTURE_NOW } },
      alert: async (): Promise<void> => {
        throw new Error(`async alert failed ${SENTINEL}`);
      },
    });

    const native = await dispositions(consumer, DEAD_LETTER_QUEUE, ["malformed"]);
    expect(native?.acks).toEqual([]);
    expect(native?.retryIds).toEqual(["msg_0"]);

    const structural = structuralBatch(DEAD_LETTER_QUEUE, ["malformed"]);
    await consumer(structural.batch);
    expect(structural.order).toEqual(["retry:0"]);
    expect(structural.retryDelays).toEqual([RETRY_DELAY_SECONDS]);
    expect(fake.snapshot().publications).toEqual([]);
  });
});

describe("disposition safety", () => {
  it("surfaces a fixed operational error when a native disposition throws, with one attempt only", async () => {
    const { consumer, fake } = harness();
    const seeded = await seedPublication(fake, { suffix: "disposition1" });
    const failing = structuralBatch(
      MAIN_QUEUE,
      [envelopeBody(seeded.publicationId, seeded.jobId)],
      { ackThrows: new Error(`native ack failed ${SENTINEL}`) },
    );

    let caught: unknown;
    await consumer(failing.batch).catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(QueueConsumerError);
    expect((caught as QueueConsumerError).code).toBe("QUEUE_DISPOSITION_FAILED");
    expect(errorText(caught)).not.toContain(SENTINEL);
    // Exactly one disposition attempt: no retry after the failed ack.
    expect(failing.order).toEqual(["ack:0"]);
    expect(failing.retryDelays).toEqual([]);
  });

  it("surfaces a fixed operational error when a retry disposition throws", async () => {
    const { consumer } = harness();
    const failing = structuralBatch(MAIN_QUEUE, ["not-an-envelope"], {
      retryThrows: new Error(`native retry failed ${SENTINEL}`),
    });

    let caught: unknown;
    await consumer(failing.batch).catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(QueueConsumerError);
    expect((caught as QueueConsumerError).code).toBe("QUEUE_DISPOSITION_FAILED");
    expect(errorText(caught)).not.toContain(SENTINEL);
    expect(failing.order).toEqual(["retry:0"]);
  });
});
