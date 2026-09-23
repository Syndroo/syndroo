import { describe, expect, it } from "vitest";

import type { Platform } from "@syndroo/core";

import {
  StoreUnavailable,
  type DeadLetterCondition,
  type DeadLetterOutcome,
  type Logger,
  type QueueEnvelopeV1,
  type SafeLogEvent,
} from "../src/index.js";
import { executePublication } from "../src/use-cases/execute-publication.js";
import {
  settleDeadLetterMessage,
  type DlqConsumerOutcome,
  type SettleDeadLetterDependencies,
} from "../src/use-cases/settle-dead-letter.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  createTransaction,
  instant,
  type SnapshotFake,
} from "../src/testing/index.js";
import type { UseCaseClock } from "../src/use-cases/shared.js";

const PUBLICATION_ID = "pub_dlq1";
const JOB_ID = "job_dlq1";
const OTHER_PUBLICATION_ID = "pub_dlq2";
const OTHER_JOB_ID = "job_dlq2";

const FIXED_CLOCK: UseCaseClock = { now: () => FIXTURE_NOW };

/** The consumer's dependency surface is exactly this narrow. */
interface RecordingDependencies {
  readonly dependencies: SettleDeadLetterDependencies;
  readonly calls: DeadLetterCondition[];
  readonly events: SafeLogEvent[];
}

function recordingDeps(
  fake: SnapshotFake,
  options: {
    readonly clock?: UseCaseClock;
    readonly logger?: Logger;
    readonly fail?: Error;
  } = {},
): RecordingDependencies {
  const calls: DeadLetterCondition[] = [];
  const events: SafeLogEvent[] = [];
  const logger: Logger = {
    write(event: SafeLogEvent): void {
      events.push(event);
      options.logger?.write(event);
    },
  };
  return {
    calls,
    events,
    dependencies: {
      publishing: {
        async settleDeadLetter(input: DeadLetterCondition): Promise<DeadLetterOutcome> {
          calls.push(input);
          if (options.fail !== undefined) {
            throw options.fail;
          }
          return fake.publishing.settleDeadLetter(input);
        },
      },
      clock: options.clock ?? FIXED_CLOCK,
      logger,
    },
  };
}

interface SeedOptions {
  readonly publicationId?: string;
  readonly jobId?: string;
  readonly platform?: Platform;
  readonly scheduledAt?: string | null;
}

async function seedPublication(
  fake: SnapshotFake,
  options: SeedOptions = {},
): Promise<void> {
  const publicationId = options.publicationId ?? PUBLICATION_ID;
  const jobId = options.jobId ?? JOB_ID;
  const postId = `post_${publicationId}`;
  await fake.publishing.createPostWithDispatch(
    createTransaction({
      key: null,
      postId,
      platforms: [options.platform ?? "x"],
      publicationIds: [publicationId],
      jobIds: [jobId],
      // A future schedule moves the same job's business due time.
      scheduledAt: options.scheduledAt ?? null,
    }),
  );
}

function dlqEnvelope(
  publicationId: string = PUBLICATION_ID,
  jobId: string = JOB_ID,
): QueueEnvelopeV1 {
  return {
    version: 1,
    jobId,
    kind: "delivery.execute",
    entityId: publicationId,
    enqueuedAt: FIXTURE_NOW,
  };
}

describe("settleDeadLetterMessage quarantine", () => {
  it("quarantines a malformed message with a fixed code and zero domain calls", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const recording = recordingDeps(fake);
    const sentinel = "SENTINEL-dlq-body-51c8";
    const before = fake.snapshot();

    const malformed: readonly unknown[] = [
      "not-an-object",
      null,
      42,
      {},
      { ...dlqEnvelope(), version: 2 },
      { ...dlqEnvelope(), kind: "delivery.other" },
      { entityId: PUBLICATION_ID, jobId: JOB_ID },
      { ...dlqEnvelope(), extra: sentinel },
      { ...dlqEnvelope(), credential: sentinel },
      { ...dlqEnvelope(), jobId: `job_${sentinel}`, body: sentinel },
      { ...dlqEnvelope(), big: "x".repeat(4000) },
    ];

    for (const message of malformed) {
      const outcome: DlqConsumerOutcome = await settleDeadLetterMessage(
        message,
        recording.dependencies,
      );
      expect(outcome).toEqual({ kind: "quarantined", reason: "malformed_envelope" });
      expect(Object.isFrozen(outcome)).toBe(true);
    }

    // No settlement call, no domain write, and nothing from the rejected input
    // is echoed outward - not the body text and not the ids it carried.
    expect(recording.calls).toHaveLength(0);
    expect(fake.snapshot()).toEqual(before);
    expect(JSON.stringify(recording.events)).not.toContain(sentinel);
    expect(JSON.stringify(recording.events)).not.toContain(`job_${sentinel}`);
    expect(recording.events.map((event) => event.event)).toEqual([
      ...Array(malformed.length).fill("dlq_message_quarantined"),
    ]);
    expect(recording.events.every((event) => event.fields?.["code"] === "malformed_envelope")).toBe(
      true,
    );
  });

  it("quarantines hostile inputs that throw after serialisation", async () => {
    const sentinel = "SENTINEL-hostile-dlq-7f26";
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const recording = recordingDeps(fake);
    const base = {
      version: 1,
      jobId: JOB_ID,
      kind: "delivery.execute",
      entityId: PUBLICATION_ID,
      enqueuedAt: FIXTURE_NOW,
    };

    // Descriptor trap that only fails on the second pass: serialisation passes,
    // the decoder's own key/field reads then throw.
    const descriptorCalls: number[] = [];
    const proxy = new Proxy(base, {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls.push(1);
        if (descriptorCalls.length > 5) {
          throw new Error(`proxy trap ${sentinel}`);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    // Non-enumerable throwing getter on a required field: serialisation skips
    // it, the later property read throws.
    const getter: Record<string, unknown> = { ...base };
    Object.defineProperty(getter, "version", {
      configurable: true,
      enumerable: false,
      get(): never {
        throw new Error(`getter ${sentinel}`);
      },
    });

    for (const hostile of [proxy, getter]) {
      expect(await settleDeadLetterMessage(hostile, recording.dependencies)).toEqual({
        kind: "quarantined",
        reason: "malformed_envelope",
      });
    }

    expect(recording.calls).toHaveLength(0);
    expect(fake.snapshot().publications[0]?.status).toBe("pending");
    expect(JSON.stringify(recording.events)).not.toContain(sentinel);
    expect(recording.events.map((event) => event.event)).toEqual([
      "dlq_message_quarantined",
      "dlq_message_quarantined",
    ]);
  });
});

describe("settleDeadLetterMessage settlement", () => {
  it("dead-letters a due, unclaimed current job without executing anything", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const recording = recordingDeps(fake);

    expect(await settleDeadLetterMessage(dlqEnvelope(), recording.dependencies)).toEqual({
      kind: "settled",
      reason: "dead_lettered",
    });
    expect(recording.calls).toEqual([
      {
        jobId: JOB_ID,
        publicationId: PUBLICATION_ID,
        now: FIXTURE_NOW,
        transportReason: "queue_dlq",
      },
    ]);
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("dead_lettered");
    expect(publication?.errorAmbiguous).toBe(false);
    // No attempt was consumed, no claim was taken and nothing re-armed.
    expect(publication?.attempts).toBe(0);
    expect(publication?.claimToken).toBeNull();
    const job = fake.snapshot().jobs[0];
    expect(job?.dlqSeenAt).toBe(FIXTURE_NOW);
    expect(job?.transportReason).toBe("queue_dlq");
    expect(job?.attemptNo).toBe(1);
  });

  it("records a future DLQ while preserving the job's due time", async () => {
    const future = instant(600_000);
    const fake = createSnapshotFake();
    await seedPublication(fake, { scheduledAt: future });
    const recording = recordingDeps(fake);

    expect(await settleDeadLetterMessage(dlqEnvelope(), recording.dependencies)).toEqual({
      kind: "settled",
      reason: "not_due",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("scheduled");
    expect(publication?.currentJobId).toBe(JOB_ID);
    expect(publication?.attempts).toBe(0);
    const job = fake.snapshot().jobs[0];
    expect(job?.availableAt).toBe(future);
    expect(job?.status).toBe("pending");
    expect(job?.dlqSeenAt).toBe(FIXTURE_NOW);
  });

  it("leaves a live claim and a terminal publication protected", async () => {
    const claimed = createSnapshotFake();
    await seedPublication(claimed);
    const claim = await claimed.publishing.claimExecution({
      jobId: JOB_ID,
      publicationId: PUBLICATION_ID,
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_live",
      attemptId: "attempt_live",
    });
    expect(claim.kind).toBe("claimed");
    const claimRecording = recordingDeps(claimed);
    expect(await settleDeadLetterMessage(dlqEnvelope(), claimRecording.dependencies)).toEqual({
      kind: "settled",
      reason: "duplicate",
    });
    const claimedPublication = claimed.snapshot().publications[0];
    expect(claimedPublication?.status).toBe("publishing");
    expect(claimedPublication?.claimToken).toBe("claim_live");
    expect(claimedPublication?.attempts).toBe(1);
    expect(claimedPublication?.terminalReason).toBeNull();

    const published = createSnapshotFake();
    await seedPublication(published);
    expect(
      (
        await published.publishing.claimExecution({
          jobId: JOB_ID,
          publicationId: PUBLICATION_ID,
          attemptNo: 1,
          now: FIXTURE_NOW,
          credentialSlotRevision: 0,
          claimToken: "claim_done",
          attemptId: "attempt_done",
        })
      ).kind,
    ).toBe("claimed");
    expect(
      (
        await published.publishing.commitExecution({
          jobId: JOB_ID,
          publicationId: PUBLICATION_ID,
          attemptId: "attempt_done",
          claimToken: "claim_done",
          now: FIXTURE_NOW,
          outcome: "published",
          externalId: "ext-1",
          externalUrl: null,
          archive: null,
        })
      ).kind,
    ).toBe("applied");
    const publishedRecording = recordingDeps(published);
    expect(
      await settleDeadLetterMessage(dlqEnvelope(), publishedRecording.dependencies),
    ).toEqual({ kind: "settled", reason: "terminal" });
    const publishedPublication = published.snapshot().publications[0];
    expect(publishedPublication?.status).toBe("published");
    expect(publishedPublication?.externalId).toBe("ext-1");
    expect(publishedPublication?.errorAmbiguous).toBe(false);
  });

  it("recovers a stale claim conservatively as unknown", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    expect(
      (
        await fake.publishing.claimExecution({
          jobId: JOB_ID,
          publicationId: PUBLICATION_ID,
          attemptNo: 1,
          now: FIXTURE_NOW,
          credentialSlotRevision: 0,
          claimToken: "claim_stale",
          attemptId: "attempt_stale",
        })
      ).kind,
    ).toBe("claimed");
    const later = instant(16 * 60_000);
    const recording = recordingDeps(fake, { clock: { now: () => later } });

    expect(await settleDeadLetterMessage(dlqEnvelope(), recording.dependencies)).toEqual({
      kind: "settled",
      reason: "terminal",
    });
    const publication = fake.snapshot().publications[0];
    expect(publication?.status).toBe("failed");
    expect(publication?.terminalReason).toBe("unknown");
    expect(publication?.errorAmbiguous).toBe(true);
    expect(publication?.attempts).toBe(1);
  });

  it("never revives a superseded job or a cross-entity message", async () => {
    const superseded = createSnapshotFake();
    await seedPublication(superseded);
    await superseded.publishing.claimExecution({
      jobId: JOB_ID,
      publicationId: PUBLICATION_ID,
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_1",
      attemptId: "attempt_1",
    });
    const retry = await superseded.publishing.commitExecution({
      jobId: JOB_ID,
      publicationId: PUBLICATION_ID,
      attemptId: "attempt_1",
      claimToken: "claim_1",
      now: FIXTURE_NOW,
      outcome: "safe_retry",
      errorCode: "RATE_LIMIT",
      retryAt: instant(60_000),
      nextJob: {
        id: "job_next",
        kind: "delivery.execute",
        aggregateId: PUBLICATION_ID,
        attemptNo: 2,
        availableAt: instant(60_000),
      },
      archive: null,
    });
    expect(retry.kind).toBe("applied");
    const supersededBefore = superseded.snapshot();
    const supersededRecording = recordingDeps(superseded);
    expect(
      await settleDeadLetterMessage(dlqEnvelope(), supersededRecording.dependencies),
    ).toEqual({ kind: "settled", reason: "stale_job" });
    const supersededPublication = superseded.snapshot().publications[0];
    expect(supersededPublication?.status).toBe("pending");
    expect(supersededPublication?.currentJobId).toBe("job_next");
    const nextJob = superseded.snapshot().jobs.find((job) => job.id === "job_next");
    expect(nextJob?.status).toBe("pending");
    expect(nextJob?.dlqSeenAt).toBeNull();
    expect(superseded.snapshot().jobs.find((job) => job.id === JOB_ID)?.status).toBe(
      supersededBefore.jobs.find((job) => job.id === JOB_ID)?.status,
    );

    const crossEntity = createSnapshotFake();
    await seedPublication(crossEntity);
    await seedPublication(crossEntity, {
      publicationId: OTHER_PUBLICATION_ID,
      jobId: OTHER_JOB_ID,
    });
    const otherBefore = crossEntity.snapshot().publications.find(
      (publication) => publication.id === OTHER_PUBLICATION_ID,
    );
    const crossRecording = recordingDeps(crossEntity);
    expect(
      await settleDeadLetterMessage(
        dlqEnvelope(OTHER_PUBLICATION_ID, JOB_ID),
        crossRecording.dependencies,
      ),
    ).toEqual({ kind: "settled", reason: "stale_job" });
    const otherAfter = crossEntity.snapshot().publications.find(
      (publication) => publication.id === OTHER_PUBLICATION_ID,
    );
    expect(otherAfter).toEqual(otherBefore);
    expect(crossEntity.snapshot().jobs.find((job) => job.id === JOB_ID)?.dlqSeenAt).toBeNull();
  });

  it("defers on a store failure without a second attempt or raw detail", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const sentinel = "SENTINEL-store-error-8ab4";
    const recording = recordingDeps(fake, {
      fail: new StoreUnavailable(`storage exploded ${sentinel}`),
    });
    const before = fake.snapshot();

    expect(await settleDeadLetterMessage(dlqEnvelope(), recording.dependencies)).toEqual({
      kind: "infrastructure_retry",
      reason: "dlq_metadata_write_failed",
    });
    // Exactly one application-level attempt: the DLQ runtime owns retries.
    expect(recording.calls).toHaveLength(1);
    expect(fake.snapshot()).toEqual(before);
    expect(JSON.stringify(recording.events)).not.toContain(sentinel);
  });

  it("keeps a settlement when the logger throws", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const recording = recordingDeps(fake, {
      logger: {
        write(): void {
          throw new Error("logger exploded");
        },
      },
    });

    expect(await settleDeadLetterMessage(dlqEnvelope(), recording.dependencies)).toEqual({
      kind: "settled",
      reason: "dead_lettered",
    });
    expect(fake.snapshot().publications[0]?.terminalReason).toBe("dead_lettered");
  });

  it("cannot reach a claim, provider, re-arm or schedule port at all", async () => {
    const fake = createSnapshotFake();
    await seedPublication(fake);
    const recording = recordingDeps(fake);

    // Structural proof: the dependency surface contains only the DLQ settlement
    // transaction plus clock/logger, so no other application port can be called.
    expect(Object.keys(recording.dependencies.publishing)).toEqual(["settleDeadLetter"]);
    expect(Object.keys(recording.dependencies).sort()).toEqual(["clock", "logger", "publishing"]);

    expect(
      await settleDeadLetterMessage(dlqEnvelope(), recording.dependencies),
    ).toEqual({ kind: "settled", reason: "dead_lettered" });
    const publication = fake.snapshot().publications[0];
    expect(publication?.attempts).toBe(0);
    expect(publication?.claimToken).toBeNull();
    expect(publication?.attemptId).toBeNull();
    expect(fake.snapshot().jobs[0]?.status).toBe("cancelled");

    // The main consumer's malformed-envelope behaviour is unchanged: it still
    // answers with the ordinary bounded infrastructure retry.
    expect(
      await executePublication("not-an-envelope", {
        publishing: fake.publishing,
        outbox: fake.outbox,
        prepare: async () => {
          throw new Error("must not be called");
        },
        signer: { async sign(): Promise<string> { return "a".repeat(64); } },
        clock: FIXED_CLOCK,
        ids: (kind) => `${kind}_1`,
      }),
    ).toEqual({ kind: "infrastructure_retry", reason: "malformed_envelope" });
  });
});
