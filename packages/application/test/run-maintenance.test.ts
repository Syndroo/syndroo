import { describe, expect, it } from "vitest";

import {
  InvalidContractInputError,
  StoreUnavailable,
  type CleanupResult,
  type Logger,
  type MaintenanceBudget,
  type QueueEnvelopeV1,
  type RecoveryResult,
  type SafeLogEvent,
} from "../src/index.js";
import {
  runMaintenance,
  type MaintenanceLimits,
  type MaintenanceReport,
  type RunMaintenanceDependencies,
} from "../src/use-cases/run-maintenance.js";
import type { UseCaseClock } from "../src/use-cases/shared.js";
import {
  FIXTURE_NOW,
  createSnapshotFake,
  createTransaction,
  instant,
  type SnapshotFake,
} from "../src/testing/index.js";

const LIMITS: MaintenanceLimits = {
  recoveryLimit: 3,
  cleanupLimit: 4,
  collectionLimit: 5,
  dispatchLimit: 6,
};

const EMPTY_RECOVERY: RecoveryResult = {
  examined: 0,
  staleClaimsMarkedUnknown: 0,
  jobsRearmed: 0,
  jobsDeadLettered: 0,
  skipped: 0,
};

const EMPTY_CLEANUP: CleanupResult = { removed: 0 };

interface Harness {
  readonly dependencies: RunMaintenanceDependencies;
  readonly calls: string[];
  readonly budgets: MaintenanceBudget[];
  readonly events: SafeLogEvent[];
  readonly clockReads: () => number;
}

interface HarnessOptions {
  readonly clock?: UseCaseClock;
  readonly logger?: Logger;
  readonly shouldContinue?: () => boolean;
  readonly recovery?: (budget: MaintenanceBudget) => Promise<RecoveryResult>;
  readonly cleanup?: (budget: MaintenanceBudget) => Promise<CleanupResult>;
  readonly collection?: (budget: MaintenanceBudget) => Promise<CleanupResult>;
  readonly queue?: RunMaintenanceDependencies["queue"];
}

function harness(fake: SnapshotFake, options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const budgets: MaintenanceBudget[] = [];
  const events: SafeLogEvent[] = [];
  let reads = 0;
  const inner = options.clock;
  // Count every acquisition of the clock the orchestration actually uses.
  const clock: UseCaseClock = {
    now: (): string => {
      reads += 1;
      return inner === undefined ? FIXTURE_NOW : inner.now();
    },
  };

  return {
    calls,
    budgets,
    events,
    clockReads: () => reads,
    dependencies: {
      publishing: {
        async recoverStaleClaims(budget: MaintenanceBudget): Promise<RecoveryResult> {
          calls.push("recovery");
          budgets.push(budget);
          return options.recovery === undefined
            ? fake.publishing.recoverStaleClaims(budget)
            : options.recovery(budget);
        },
      },
      credentials: {
        async cleanupExpired(budget: MaintenanceBudget): Promise<CleanupResult> {
          calls.push("expired_cleanup");
          budgets.push(budget);
          return options.cleanup === undefined
            ? fake.credentials.cleanupExpired(budget)
            : options.cleanup(budget);
        },
      },
      outbox: {
        ...fake.outbox,
        async collectFinished(budget: MaintenanceBudget): Promise<CleanupResult> {
          calls.push("finished_collection");
          budgets.push(budget);
          return options.collection === undefined
            ? fake.outbox.collectFinished(budget)
            : options.collection(budget);
        },
      },
      queue: options.queue ?? fake.queue,
      clock,
      logger: {
        write(event: SafeLogEvent): void {
          events.push(event);
          options.logger?.write(event);
        },
      },
      ...(options.shouldContinue === undefined
        ? {}
        : { shouldContinue: options.shouldContinue }),
    },
  };
}

function summary(report: MaintenanceReport): unknown {
  return JSON.parse(JSON.stringify(report)) as unknown;
}

async function seedDueJob(
  fake: SnapshotFake,
  id: string,
): Promise<{ readonly publicationId: string; readonly jobId: string }> {
  const publicationId = `pub_${id}`;
  const jobId = `job_${id}`;
  await fake.publishing.createPostWithDispatch(
    createTransaction({
      key: null,
      postId: `post_${id}`,
      platforms: ["x"],
      publicationIds: [publicationId],
      jobIds: [jobId],
    }),
  );
  return { publicationId, jobId };
}

describe("runMaintenance phase order and budgets", () => {
  it("runs the four phases in order with a fresh canonical instant and its own limit", async () => {
    const fake = createSnapshotFake();
    const seeded = await seedDueJob(fake, "maint1");
    let reads = 0;
    const clock: UseCaseClock = {
      now: () => {
        const value = instant(reads * 1000);
        reads += 1;
        return value;
      },
    };
    const run = harness(fake, { clock });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(run.calls).toEqual(["recovery", "expired_cleanup", "finished_collection"]);
    expect(run.budgets.map((budget) => budget.now)).toEqual([
      instant(0),
      instant(1000),
      instant(2000),
    ]);
    expect(run.budgets.map((budget) => budget.limit)).toEqual([3, 4, 5]);
    // The dispatch phase read its own fresh instant and used it for the wake.
    expect(reads).toBe(4);
    expect(fake.sentEnvelopes).toHaveLength(1);
    expect(fake.sentEnvelopes[0]?.jobId).toBe(seeded.jobId);
    expect(fake.sentEnvelopes[0]?.enqueuedAt).toBe(instant(3000));
    expect(report.recovery.status).toBe("completed");
    expect(report.expiredCleanup.status).toBe("completed");
    expect(report.finishedCollection.status).toBe("completed");
    expect(report.dispatch.status).toBe("completed");
    expect(report.dispatch.dispatched).toBe(1);
  });

  it("snapshots the validated limits and the predicate before the first await", async () => {
    const fake = createSnapshotFake();
    const mutable = { ...LIMITS };
    let predicateCalls = 0;
    const run = harness(fake, {
      shouldContinue: (): boolean => {
        predicateCalls += 1;
        return true;
      },
      recovery: async (budget) => {
        // A caller mutating its own objects mid-wake must not change this wake.
        mutable.recoveryLimit = 0;
        mutable.dispatchLimit = Number.NaN;
        mutable.collectionLimit = 0;
        return { ...EMPTY_RECOVERY, examined: budget.limit };
      },
    });

    const report = await runMaintenance(mutable, run.dependencies);

    expect(run.budgets.map((budget) => budget.limit)).toEqual([3, 4, 5]);
    expect(report.recovery.examined).toBe(3);
    expect(report.dispatch.status).toBe("completed");
    expect(predicateCalls).toBeGreaterThan(0);
  });

  it("rejects invalid limits before any effect, even from a hostile object", async () => {
    const fake = createSnapshotFake();
    const hostile: unknown = {
      get recoveryLimit(): number {
        throw new Error("SENTINEL-limit-getter-3c71");
      },
      cleanupLimit: 1,
      collectionLimit: 1,
      dispatchLimit: 1,
    };
    const cases: readonly unknown[] = [
      { ...LIMITS, recoveryLimit: 0 },
      { ...LIMITS, cleanupLimit: 2.5 },
      { ...LIMITS, collectionLimit: -1 },
      { ...LIMITS, dispatchLimit: Number.NaN },
      { recoveryLimit: 1, cleanupLimit: 1, collectionLimit: 1 },
      { recoveryLimit: 1, cleanupLimit: 1, collectionLimit: 1, dispatchLimit: 0 },
      null,
      hostile,
    ];

    for (const limits of cases) {
      const run = harness(fake);
      let caught: unknown;
      await runMaintenance(limits as MaintenanceLimits, run.dependencies).catch(
        (error: unknown) => {
          caught = error;
        },
      );
      expect(caught).toBeInstanceOf(InvalidContractInputError);
      expect(String((caught as Error).message)).toContain("must be a positive safe integer");
      expect(String((caught as Error).message)).not.toContain("SENTINEL-limit-getter-3c71");
      expect(run.calls).toEqual([]);
      expect(run.clockReads()).toBe(0);
    }
  });
});

describe("runMaintenance continuation and failures", () => {
  it("skips every phase when the deadline check is false before the first phase", async () => {
    const fake = createSnapshotFake();
    const run = harness(fake, { shouldContinue: () => false });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(run.calls).toEqual([]);
    expect(run.clockReads()).toBe(0);
    for (const phase of [report.recovery, report.expiredCleanup, report.finishedCollection, report.dispatch]) {
      expect(phase.status).toBe("skipped");
      expect(phase.code).toBe("BUDGET_EXHAUSTED");
    }
    expect(report.recovery.examined).toBeNull();
    expect(report.expiredCleanup.removed).toBeNull();
    expect(report.dispatch.dispatched).toBeNull();
    expect(summary(report)).not.toEqual(
      expect.objectContaining({ recovery: expect.objectContaining({ examined: 0 }) }),
    );
  });

  it("latches the first stop and never resumes a later phase on a true answer", async () => {
    const fake = createSnapshotFake();
    let calls = 0;
    const run = harness(fake, {
      shouldContinue: (): boolean => {
        calls += 1;
        // False once, then true forever: the latch must keep the stop.
        return calls !== 2;
      },
    });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(run.calls).toEqual(["recovery"]);
    expect(report.recovery.status).toBe("completed");
    expect(report.expiredCleanup.status).toBe("skipped");
    expect(report.finishedCollection.status).toBe("skipped");
    expect(report.dispatch.status).toBe("skipped");
    // The recovery phase ran with a fresh instant; no later phase read a clock.
    expect(run.clockReads()).toBe(1);
    expect(calls).toBe(2);
  });

  it("reports each phase failure independently and still runs later phases", async () => {
    const sentinel = "SENTINEL-maintenance-failure-92bd";
    const fake = createSnapshotFake();
    const seeded = await seedDueJob(fake, "maint2");
    const run = harness(fake, {
      recovery: async () => {
        throw new StoreUnavailable(`recovery exploded ${sentinel}`);
      },
      cleanup: async () => ({ removed: sentinel as unknown as number }),
      collection: async () => {
        throw new Error(`collection exploded ${sentinel}`);
      },
    });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.recovery).toMatchObject({ status: "failed", code: "STORE_UNAVAILABLE" });
    expect(report.recovery.examined).toBeNull();
    expect(report.expiredCleanup).toMatchObject({
      status: "failed",
      code: "MALFORMED_RESULT",
    });
    expect(report.expiredCleanup.removed).toBeNull();
    expect(report.finishedCollection).toMatchObject({
      status: "failed",
      code: "STORE_UNAVAILABLE",
    });
    // A store failure never blocks the later dispatch phase.
    expect(report.dispatch.status).toBe("completed");
    expect(report.dispatch.dispatched).toBe(1);
    expect(fake.sentEnvelopes.map((envelope: QueueEnvelopeV1) => envelope.jobId)).toEqual([
      seeded.jobId,
    ]);
    expect(JSON.stringify(summary(report))).not.toContain(sentinel);
    expect(JSON.stringify(run.events)).not.toContain(sentinel);
    for (const event of run.events) {
      expect(Object.values(event.fields ?? {})).not.toContain(sentinel);
    }
  });

  it("turns a malformed numeric report into a fixed failure, never a partial copy", async () => {
    const fake = createSnapshotFake();
    const run = harness(fake, {
      recovery: async () => ({
        examined: "3" as unknown as number,
        staleClaimsMarkedUnknown: 0,
        jobsRearmed: 0,
        jobsDeadLettered: 0,
        skipped: 0,
      }),
      collection: async () => {
        const result = {};
        Object.defineProperty(result, "removed", {
          configurable: true,
          get(): never {
            throw new Error("SENTINEL-report-getter-5b0e");
          },
        });
        return result as CleanupResult;
      },
    });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.recovery).toMatchObject({ status: "failed", code: "MALFORMED_RESULT" });
    expect(report.recovery.examined).toBeNull();
    expect(report.recovery.staleClaimsMarkedUnknown).toBeNull();
    expect(report.expiredCleanup.status).toBe("completed");
    expect(report.finishedCollection).toMatchObject({
      status: "failed",
      code: "MALFORMED_RESULT",
    });
    expect(report.finishedCollection.removed).toBeNull();
    expect(JSON.stringify(summary(report))).not.toContain("SENTINEL-report-getter-5b0e");
  });

  it("fails a phase with a fixed clock code instead of a raw clock error", async () => {
    const sentinel = "SENTINEL-clock-7d15";
    const cases: readonly UseCaseClock[] = [
      {
        now: (): never => {
          throw new Error(`clock exploded ${sentinel}`);
        },
      },
      { now: () => "2026-09-23T09:00:00+09:00" },
    ];

    for (const clock of cases) {
      const fake = createSnapshotFake();
      const run = harness(fake, { clock });
      const report = await runMaintenance(LIMITS, run.dependencies);

      expect(run.calls).toEqual([]);
      for (const phase of [
        report.recovery,
        report.expiredCleanup,
        report.finishedCollection,
        report.dispatch,
      ]) {
        expect(phase.status).toBe("failed");
        expect(phase.code).toBe("CLOCK_UNAVAILABLE");
      }
      expect(report.recovery.examined).toBeNull();
      expect(report.dispatch.sent).toBeNull();
      // Each phase still tried its own fresh read.
      expect(run.clockReads()).toBe(4);
      expect(JSON.stringify(summary(report))).not.toContain(sentinel);
      expect(JSON.stringify(run.events)).not.toContain(sentinel);
    }
  });

  it("keeps later phases running when only the first clock read fails", async () => {
    const fake = createSnapshotFake();
    await seedDueJob(fake, "maint3");
    let reads = 0;
    const clock: UseCaseClock = {
      now: (): string => {
        reads += 1;
        if (reads === 1) {
          throw new Error("transient clock failure");
        }
        return FIXTURE_NOW;
      },
    };
    const run = harness(fake, { clock });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.recovery).toMatchObject({ status: "failed", code: "CLOCK_UNAVAILABLE" });
    expect(report.expiredCleanup.status).toBe("completed");
    expect(report.finishedCollection.status).toBe("completed");
    expect(report.dispatch.status).toBe("completed");
    expect(report.dispatch.dispatched).toBe(1);
  });

  it("keeps the report when the logger throws", async () => {
    const fake = createSnapshotFake();
    const logger: Logger = {
      write(): void {
        throw new Error("logger exploded");
      },
    };
    const run = harness(fake, { logger });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.recovery.status).toBe("completed");
    expect(report.dispatch.status).toBe("completed");
    expect(summary(report)).toMatchObject({ recovery: { code: "COMPLETED" } });
  });
});

describe("runMaintenance real port results", () => {
  it("copies real recovery, cleanup, collection and dispatch counts", async () => {
    const fake = createSnapshotFake();

    // A stale claim: claimed at T, still publishing far past the window.
    const stale = await seedDueJob(fake, "stale");
    expect(
      (
        await fake.publishing.claimExecution({
          jobId: stale.jobId,
          publicationId: stale.publicationId,
          attemptNo: 1,
          now: FIXTURE_NOW,
          credentialSlotRevision: 0,
          claimToken: "claim_stale",
          attemptId: "attempt_stale",
        })
      ).kind,
    ).toBe("claimed");

    // An expired auth operation with residual secret material to clear.
    await fake.credentials.createAuthOperation({
      operationId: "op_expired",
      platform: "x",
      now: FIXTURE_NOW,
      expectedRevision: 0,
      canonicalCallbackUrl: "https://syndroo.test/v1/auth/x/callback",
      startConfigBinding: "config-binding-1",
      oauthState: "state_expired",
      requestToken: null,
      requestSecret: null,
      requestSecretPurpose: null,
      requestSecretRevision: null,
      expiresAt: instant(-1000),
    });

    // A finished transport intent: published, so its job is cancelled.
    const finished = await seedDueJob(fake, "finished");
    await fake.publishing.claimExecution({
      jobId: finished.jobId,
      publicationId: finished.publicationId,
      attemptNo: 1,
      now: FIXTURE_NOW,
      credentialSlotRevision: 0,
      claimToken: "claim_finished",
      attemptId: "attempt_finished",
    });
    expect(
      (
        await fake.publishing.commitExecution({
          jobId: finished.jobId,
          publicationId: finished.publicationId,
          attemptId: "attempt_finished",
          claimToken: "claim_finished",
          now: FIXTURE_NOW,
          outcome: "published",
          externalId: "ext-finished",
          externalUrl: null,
          archive: null,
        })
      ).kind,
    ).toBe("applied");

    // One due job left for the dispatch phase.
    const due = await seedDueJob(fake, "due");
    const later = instant(31 * 24 * 60 * 60_000);
    const run = harness(fake, { clock: { now: () => later } });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.recovery).toEqual({
      phase: "recovery",
      status: "completed",
      code: "COMPLETED",
      examined: 1,
      staleClaimsMarkedUnknown: 1,
      jobsRearmed: 0,
      jobsDeadLettered: 0,
      skipped: 0,
    });
    expect(report.expiredCleanup).toEqual({
      phase: "expired_cleanup",
      status: "completed",
      code: "COMPLETED",
      removed: 1,
    });
    expect(report.finishedCollection).toEqual({
      phase: "finished_collection",
      status: "completed",
      code: "COMPLETED",
      removed: 1,
    });
    expect(report.dispatch).toMatchObject({
      phase: "dispatch",
      status: "completed",
      code: "COMPLETED",
      examined: 1,
      sent: 1,
      dispatched: 1,
      sendFailed: 0,
      sendUnknown: 0,
    });
    expect(fake.sentEnvelopes.map((envelope: QueueEnvelopeV1) => envelope.jobId)).toEqual([
      due.jobId,
    ]);
  });

  it("lets the dispatch budget stop new sends while keeping accepted work", async () => {
    const fake = createSnapshotFake();
    const first = await seedDueJob(fake, "budget1");
    const second = await seedDueJob(fake, "budget2");
    let allow = true;
    const queue = {
      async send(message: QueueEnvelopeV1): Promise<void> {
        await fake.queue.send(message);
        // The deadline expires right after the first accepted send.
        allow = false;
      },
    };
    const run = harness(fake, {
      queue,
      shouldContinue: () => allow,
    });

    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.dispatch.status).toBe("completed");
    expect(report.dispatch.examined).toBe(2);
    expect(report.dispatch.sent).toBe(1);
    expect(report.dispatch.dispatched).toBe(1);
    expect(report.dispatch.unstarted).toBe(1);
    expect(fake.sentEnvelopes.map((envelope: QueueEnvelopeV1) => envelope.jobId)).toEqual([
      first.jobId,
    ]);
    const jobs = fake.snapshot().jobs;
    expect(jobs.find((job) => job.id === first.jobId)?.status).toBe("dispatched");
    expect(jobs.find((job) => job.id === second.jobId)?.status).toBe("pending");
  });

  it("reaches no claim, provider, preparation, decryption or refresh path", async () => {
    const fake = createSnapshotFake();
    const before = fake.snapshot();
    const run = harness(fake);

    expect(Object.keys(run.dependencies.publishing)).toEqual(["recoverStaleClaims"]);
    expect(Object.keys(run.dependencies.credentials)).toEqual(["cleanupExpired"]);
    const report = await runMaintenance(LIMITS, run.dependencies);

    expect(report.recovery.status).toBe("completed");
    // An empty store leaves every row untouched: no claim, provider or write.
    expect(fake.snapshot()).toEqual(before);
    expect(fake.sentEnvelopes).toEqual([]);
  });
});
