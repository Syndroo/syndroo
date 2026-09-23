import { describe, expect, it } from "vitest";

import type { Platform, Publisher, PublishRequest, PublishResult } from "@syndroo/core";

import {
  JobQueueError,
  encodeBindingMaterial,
  type BindingSigner,
  type JobQueue,
  type Logger,
  type PublisherPreparation,
  type QueueEnvelopeV1,
  type SafeLogEvent,
  type SafePlatformStatus,
} from "../src/index.js";
import { createPost } from "../src/use-cases/create-post.js";
import {
  dispatchReadyJobs,
  dispatchReportDeferred,
  type DispatchReadyJobsInput,
} from "../src/use-cases/dispatch-ready-jobs.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  createTransaction,
  instant,
  type SnapshotFake,
} from "../src/testing/index.js";

const HEX_SIGNER: BindingSigner = {
  async sign(): Promise<string> {
    return "a".repeat(64);
  },
};

interface SeededJobs {
  readonly jobIds: readonly string[];
  readonly publicationIds: readonly string[];
}

/** Commit `count` due outbox jobs directly, without running the fast path. */
async function seedDueJobs(fake: SnapshotFake, count: number): Promise<SeededJobs> {
  const jobIds: string[] = [];
  const publicationIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const jobId = `job_seed${suffix}`;
    const publicationId = `pub_seed${suffix}`;
    await fake.publishing.createPostWithDispatch(
      createTransaction({
        key: null,
        postId: `post_seed${suffix}`,
        platforms: ["x"],
        publicationIds: [publicationId],
        jobIds: [jobId],
      }),
    );
    jobIds.push(jobId);
    publicationIds.push(publicationId);
  }
  return { jobIds, publicationIds };
}

function dispatch(
  fake: SnapshotFake,
  overrides: Partial<DispatchReadyJobsInput> = {},
): ReturnType<typeof dispatchReadyJobs> {
  return dispatchReadyJobs({
    outbox: fake.outbox,
    queue: fake.queue,
    now: FIXTURE_NOW,
    ...overrides,
  });
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

function readyPreparation(platform: Platform): PublisherPreparation {
  const publisher: Publisher = {
    name: `${platform}-provider`,
    async publish(request: PublishRequest): Promise<PublishResult> {
      return { externalId: `${request.publicationId}-external` };
    },
  };
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
        fields: [["X_API_KEY", "test-key"]],
      }),
      credentialRevision: 0,
      credentialSource: "env",
    },
  };
}

describe("dispatchReadyJobs run budget", () => {
  it("caps a wake at the tick budget and drains the rest on a later wake", async () => {
    const fake = createSnapshotFake();
    await seedDueJobs(fake, 25);

    const first = await dispatch(fake);
    expect(first).toMatchObject({
      examined: 20,
      sent: 20,
      dispatched: 20,
      markFailed: 0,
      sendFailed: 0,
      sendUnknown: 0,
      unstarted: 0,
    });
    expect(first.confirmedJobIds).toHaveLength(20);
    expect(fake.sentEnvelopes).toHaveLength(20);
    expect(fake.snapshot().jobs.filter((job) => job.status === "pending")).toHaveLength(5);

    const second = await dispatch(fake);
    expect(second.examined).toBe(5);
    expect(second.dispatched).toBe(5);
    expect(fake.sentEnvelopes).toHaveLength(25);
    expect(fake.snapshot().jobs.every((job) => job.status === "dispatched")).toBe(true);
  });

  it("honours a lower limit and caps a larger one", async () => {
    const small = createSnapshotFake();
    await seedDueJobs(small, 25);
    const limited = await dispatch(small, { limit: 3 });
    expect(limited.examined).toBe(3);
    expect(limited.sent).toBe(3);
    expect(limited.dispatched).toBe(3);
    expect(small.sentEnvelopes).toHaveLength(3);

    const large = createSnapshotFake();
    await seedDueJobs(large, 25);
    const capped = await dispatch(large, { limit: 50 });
    expect(capped.examined).toBe(20);
    expect(large.sentEnvelopes).toHaveLength(20);
  });

  it("stops starting new sends when the budget predicate says stop", async () => {
    const fake = createSnapshotFake();
    const seeded = await seedDueJobs(fake, 5);
    let decisions = 0;
    const report = await dispatch(fake, {
      shouldContinue: (): boolean => {
        decisions += 1;
        return decisions <= 2;
      },
    });

    expect(report.examined).toBe(5);
    expect(report.sent).toBe(2);
    expect(report.dispatched).toBe(2);
    expect(report.unstarted).toBe(3);
    expect(fake.sentEnvelopes).toHaveLength(2);
    // Exactly one budget decision per job: no same-tick retry or re-scan.
    expect(decisions).toBe(3);
    expect(
      fake
        .snapshot()
        .jobs.filter((job) => job.status === "pending")
        .map((job) => job.id),
    ).toEqual(seeded.jobIds.slice(2));
  });
});

describe("dispatchReadyJobs transport outcomes", () => {
  it("distinguishes a known send failure from an unknown outcome and keeps both pending", async () => {
    const cases: readonly {
      readonly error: Error;
      readonly field: "sendFailed" | "sendUnknown";
      readonly code: string;
    }[] = [
      {
        error: new JobQueueError("broker rejected", "failed", "SEND_FAILED"),
        field: "sendFailed",
        code: "SEND_FAILED",
      },
      {
        error: new JobQueueError("broker timeout", "unknown", "SEND_UNKNOWN"),
        field: "sendUnknown",
        code: "SEND_UNKNOWN",
      },
      { error: new Error("socket reset"), field: "sendUnknown", code: "SEND_UNKNOWN" },
    ];

    for (const entry of cases) {
      const fake = createSnapshotFake();
      const seeded = await seedDueJobs(fake, 1);
      fake.faults.inject({ failNextQueueSend: entry.error });

      const report = await dispatch(fake);
      expect(report.examined).toBe(1);
      expect(report.sent).toBe(0);
      expect(report[entry.field]).toBe(1);
      expect(fake.sentEnvelopes).toHaveLength(0);

      const job = fake.snapshot().jobs.find((row) => row.id === seeded.jobIds[0]);
      expect(job?.status).toBe("pending");
      expect(job?.lastDispatchErrorCode).toBe(entry.code);
      expect(job?.dispatchAttemptCount).toBe(1);
    }
  });

  it("attempts each failing job once per wake", async () => {
    const fake = createSnapshotFake();
    await seedDueJobs(fake, 2);
    let attempts = 0;
    const queue: JobQueue = {
      async send(): Promise<void> {
        attempts += 1;
        throw new JobQueueError("down", "failed", "SEND_FAILED");
      },
    };
    const report = await dispatch(fake, { queue });
    expect(report.sendFailed).toBe(2);
    expect(attempts).toBe(2);
  });

  it("never sends a second copy when an accepted send loses its mark", async () => {
    const fake = createSnapshotFake();
    await seedDueJobs(fake, 1);
    fake.faults.inject({ failNextDispatchRecordAfterStage: new Error("mark lost") });

    const report = await dispatch(fake);
    expect(report).toEqual({
      examined: 1,
      sent: 1,
      dispatched: 0,
      markFailed: 1,
      sendFailed: 0,
      sendUnknown: 0,
      unstarted: 0,
      confirmedJobIds: [],
    });
    // An accepted send with a lost mark leaves a durably pending job, so the
    // caller must treat the wake as deferred.
    expect(dispatchReportDeferred(report)).toBe(true);
    expect(fake.sentEnvelopes).toHaveLength(1);
    expect(fake.snapshot().jobs[0]?.status).toBe("pending");
  });

  it("treats a mark that lost to newer intent as a duplicate rather than resending", async () => {
    const fake = createSnapshotFake();
    const seeded = await seedDueJobs(fake, 1);
    let sends = 0;
    let marks = 0;
    const queue: JobQueue = {
      async send(): Promise<void> {
        sends += 1;
        // The consumer rearmed the same current job while the message was in
        // flight, so the producer's dispatch revision is already stale.
        const rearmed = await fake.outbox.rearmCurrentJob({
          jobId: seeded.jobIds[0] ?? "",
          publicationId: seeded.publicationIds[0] ?? "",
          now: FIXTURE_NOW,
          reason: "early_message",
        });
        expect(rearmed.kind).toBe("rearmed");
      },
    };
    const counting: { readonly outbox: DispatchReadyJobsInput["outbox"] } = {
      outbox: {
        ...fake.outbox,
        async recordDispatch(input): Promise<Awaited<ReturnType<typeof fake.outbox.recordDispatch>>> {
          marks += 1;
          return fake.outbox.recordDispatch(input);
        },
      },
    };

    const report = await dispatch(fake, { queue, outbox: counting.outbox });
    expect(sends).toBe(1);
    expect(marks).toBe(1);
    expect(report.sent).toBe(1);
    expect(report.dispatched).toBe(0);
    expect(report.markFailed).toBe(1);
    const job = fake.snapshot().jobs[0];
    expect(job?.status).toBe("pending");
    expect(job?.dispatchRevision).toBe(1);
  });

  it("reuses the same persisted job identity across wakes", async () => {
    const fake = createSnapshotFake();
    const seeded = await seedDueJobs(fake, 1);
    fake.faults.inject({
      failNextQueueSend: new JobQueueError("broker rejected", "failed", "SEND_FAILED"),
    });

    const first = await dispatch(fake);
    expect(first.sendFailed).toBe(1);
    const second = await dispatch(fake);
    expect(second.dispatched).toBe(1);

    expect(fake.sentEnvelopes).toHaveLength(1);
    expect(fake.sentEnvelopes[0]?.jobId).toBe(seeded.jobIds[0]);
    expect(fake.sentEnvelopes[0]?.entityId).toBe(seeded.publicationIds[0]);
    const job = fake.snapshot().jobs[0];
    expect(job?.status).toBe("dispatched");
    expect(job?.dispatchAttemptCount).toBe(2);
  });
});

describe("dispatchReadyJobs boundaries", () => {
  it("validates the limit, budget predicate, instant and trace id", async () => {
    const fake = createSnapshotFake();
    await expect(dispatch(fake, { limit: 0 })).rejects.toThrow(
      "dispatch limit must be a positive safe integer",
    );
    await expect(dispatch(fake, { limit: 2.5 })).rejects.toThrow(
      "dispatch limit must be a positive safe integer",
    );
    await expect(
      dispatch(fake, { shouldContinue: "no" as unknown as () => boolean }),
    ).rejects.toThrow("shouldContinue must be a function");
    await expect(dispatch(fake, { now: "2026-09-23T09:00:00+09:00" })).rejects.toThrow(
      "dispatch now must be a normalized UTC ISO instant",
    );
    await expect(dispatch(fake, { traceId: "bad trace!" })).rejects.toThrow(
      "dispatch traceId must be a bounded opaque identifier",
    );
    expect(fake.sentEnvelopes).toHaveLength(0);
  });

  it("sends only versioned identity envelopes, once per job", async () => {
    const fake = createSnapshotFake();
    const seeded = await seedDueJobs(fake, 1);
    const report = await dispatch(fake, { traceId: "trace_1" });
    expect(report.dispatched).toBe(1);
    expect(fake.sentEnvelopes).toEqual([
      {
        version: 1,
        jobId: seeded.jobIds[0] ?? "",
        kind: "delivery.execute",
        entityId: seeded.publicationIds[0] ?? "",
        enqueuedAt: FIXTURE_NOW,
        traceId: "trace_1",
      } satisfies QueueEnvelopeV1,
    ]);

    const again = await dispatch(fake);
    expect(again.examined).toBe(0);
    expect(fake.sentEnvelopes).toHaveLength(1);
  });

  it("leaves future work untouched until its due time", async () => {
    const fake = createSnapshotFake();
    const future = instant(600_000);
    await fake.publishing.createPostWithDispatch(
      createTransaction({
        key: null,
        platforms: ["x"],
        scheduledAt: future,
        postId: "post_future",
        publicationIds: ["pub_future"],
        jobIds: ["job_future"],
      }),
    );

    const early = await dispatch(fake);
    expect(early.examined).toBe(0);
    expect(fake.sentEnvelopes).toHaveLength(0);

    const later = await dispatch(fake, { now: future });
    expect(later.examined).toBe(1);
    expect(later.dispatched).toBe(1);
    expect(fake.sentEnvelopes).toHaveLength(1);
    expect(fake.sentEnvelopes[0]?.enqueuedAt).toBe(future);
  });

  it("keeps a throwing logger from changing the workflow", async () => {
    const fake = createSnapshotFake();
    await seedDueJobs(fake, 2);
    const logger: Logger = {
      write(): void {
        throw new Error("logger exploded");
      },
    };
    const report = await dispatch(fake, { logger });
    expect(report.dispatched).toBe(2);
    expect(fake.sentEnvelopes).toHaveLength(2);
  });

  it("never lets queue failure text reach logs or the report", async () => {
    const fake = createSnapshotFake();
    await seedDueJobs(fake, 1);
    const sentinel = "SENTINEL-queue-credential-8b2e";
    const queue: JobQueue = {
      async send(): Promise<void> {
        throw new JobQueueError(`broker said ${sentinel}`, "unknown", "SEND_UNKNOWN");
      },
    };
    const { logger, events } = collectingLogger();

    const report = await dispatch(fake, { queue, logger });
    expect(report.sendUnknown).toBe(1);
    expect(events.map((event) => event.event)).toEqual(["outbox_dispatch_send_unknown"]);
    expect(events[0]?.fields).toMatchObject({ code: "SEND_UNKNOWN" });
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });

  it("is the same dispatcher the create fast path uses", async () => {
    const fake = createSnapshotFake();
    const queue: JobQueue = {
      async send(): Promise<void> {
        throw new JobQueueError("broker down", "failed", "SEND_FAILED");
      },
    };
    const created = await createPost(
      { content: "shared", platforms: ["x"] },
      {
        publishing: fake.publishing,
        outbox: fake.outbox,
        queue,
        signer: HEX_SIGNER,
        prepare: async (platform) => readyPreparation(platform),
        clock: { now: () => FIXTURE_NOW },
        ids: (kind) => `${kind}_shared`,
      },
      "key-shared",
    );
    expect(created.replayed).toBe(false);
    expect(created.enqueueDeferred).toBe(true);
    expect(fake.sentEnvelopes).toHaveLength(0);

    // The later routine wake drains the pending intent with the same function.
    const report = await dispatch(fake);
    expect(report.dispatched).toBe(1);
    expect(fake.sentEnvelopes).toHaveLength(1);
    expect(fake.sentEnvelopes[0]?.jobId).toBe("job_shared");
    expect(fake.snapshot().jobs[0]?.status).toBe("dispatched");
  });
});
