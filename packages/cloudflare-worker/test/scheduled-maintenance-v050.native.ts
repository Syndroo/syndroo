/**
 * Scheduled-runtime deadline wrapper — native workerd conformance (Task 8b1).
 *
 * Runs only under `test/scheduled-maintenance-v050.vitest.config.ts`, which
 * fails closed on any outbound request and discovers exactly this file. The
 * accepted application `runMaintenance` runs against the frozen snapshot fake
 * with counted ports, so each assertion observes real phase machinery rather
 * than a re-implementation.
 *
 * Timers stay real (no blanket fake timers): the dedicated recorder wraps
 * `setTimeout`/`clearTimeout` so handle set/clear counts and scheduled delays
 * are observable without changing when they fire.
 */

import { describe, expect, it } from "vitest";

import {
  InvalidContractInputError,
  StoreUnavailable,
  type CleanupResult,
  type MaintenanceBudget,
  type QueueEnvelopeV1,
  type RecoveryResult,
} from "@syndroo/application";
import { FIXTURE_NOW, createSnapshotFake, createTransaction, instant } from "@syndroo/application/testing";

import {
  SCHEDULED_MAINTENANCE_DEADLINE_MS,
  createScheduledMaintenance,
  type ScheduledMaintenanceDependencies,
  type ScheduledMaintenanceOptions,
  type ScheduledMaintenanceOutcome,
  type ScheduledMaintenanceTimers,
} from "../src/composition/scheduled-maintenance.js";

const LIMITS: ScheduledMaintenanceOptions["limits"] = {
  recoveryLimit: 3,
  cleanupLimit: 4,
  collectionLimit: 5,
  dispatchLimit: 6,
};

/** Sentinel that must never appear in an outcome, error or report. */
const SENTINEL = "SENTINEL-scheduled-maintenance-4f2a";

const EMPTY_RECOVERY: RecoveryResult = {
  examined: 0,
  staleClaimsMarkedUnknown: 0,
  jobsRearmed: 0,
  jobsDeadLettered: 0,
  skipped: 0,
};

const EMPTY_CLEANUP: CleanupResult = { removed: 0 };

interface TimerRecorder {
  readonly timers: ScheduledMaintenanceTimers;
  readonly scheduled: number[];
  readonly cleared: () => number;
  readonly active: () => number;
}

/** Wraps the real timer functions; firing behaviour is unchanged. */
function timerRecorder(): TimerRecorder {
  const handles = new Set<ReturnType<typeof setTimeout>>();
  const scheduled: number[] = [];
  let cleared = 0;
  return {
    scheduled,
    cleared: () => cleared,
    active: () => handles.size,
    timers: {
      set: (handler: () => void, ms: number): ReturnType<typeof setTimeout> => {
        scheduled.push(ms);
        const handle = setTimeout(handler, ms);
        handles.add(handle);
        return handle;
      },
      clear: (handle): void => {
        cleared += 1;
        handles.delete(handle as ReturnType<typeof setTimeout>);
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  };
}

interface HarnessOptions {
  readonly deadlineMs?: number;
  readonly clock?: { now(): string };
  readonly monotonicNow?: () => number;
  readonly shouldContinue?: () => boolean;
  readonly recovery?: (budget: MaintenanceBudget) => Promise<RecoveryResult>;
  readonly cleanup?: (budget: MaintenanceBudget) => Promise<CleanupResult>;
  readonly collection?: (budget: MaintenanceBudget) => Promise<CleanupResult>;
  readonly queue?: ScheduledMaintenanceDependencies["queue"];
  readonly timers?: ScheduledMaintenanceTimers;
  readonly overrides?: Partial<ScheduledMaintenanceDependencies>;
}

interface Harness {
  readonly wake: (options: ScheduledMaintenanceOptions) => Promise<ScheduledMaintenanceOutcome>;
  readonly calls: string[];
  readonly budgets: MaintenanceBudget[];
  readonly fake: ReturnType<typeof createSnapshotFake>;
  readonly timers: TimerRecorder;
}

function harness(options: HarnessOptions = {}): Harness {
  const fake = createSnapshotFake();
  const calls: string[] = [];
  const budgets: MaintenanceBudget[] = [];
  const timers = timerRecorder();
  const deadlines: ScheduledMaintenanceTimers =
    options.timers ?? timers.timers;

  const dependencies: ScheduledMaintenanceDependencies = {
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
    clock: options.clock ?? { now: () => FIXTURE_NOW },
    timers: deadlines,
    ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
    ...(options.shouldContinue === undefined ? {} : { shouldContinue: options.shouldContinue }),
    ...options.overrides,
  };

  return {
    calls,
    budgets,
    fake,
    timers,
    wake: createScheduledMaintenance(dependencies),
  };
}

async function seedDueJobs(
  fake: ReturnType<typeof createSnapshotFake>,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, "0");
    await fake.publishing.createPostWithDispatch(
      createTransaction({
        key: null,
        postId: `post_${suffix}`,
        platforms: ["x"],
        publicationIds: [`pub_${suffix}`],
        jobIds: [`job_${suffix}`],
      }),
    );
  }
}

describe("scheduled maintenance wake", () => {
  it("runs the accepted phases in order with a fresh clock, explicit limits and a completed report", async () => {
    let reads = 0;
    const harnessed = harness({
      clock: {
        now: () => {
          const value = instant(reads * 1000);
          reads += 1;
          return value;
        },
      },
    });
    await seedDueJobs(harnessed.fake, 1);
    const fake = harnessed.fake;

    const outcome = await harnessed.wake({ limits: LIMITS });

    expect(outcome.kind).toBe("completed");
    expect(harnessed.calls).toEqual(["recovery", "expired_cleanup", "finished_collection"]);
    expect(harnessed.budgets.map((budget) => budget.now)).toEqual([
      instant(0),
      instant(1000),
      instant(2000),
    ]);
    expect(harnessed.budgets.map((budget) => budget.limit)).toEqual([3, 4, 5]);
    // The dispatch phase read its own fresh instant for the wake.
    expect(reads).toBe(4);
    expect(fake.sentEnvelopes.map((envelope: QueueEnvelopeV1) => envelope.enqueuedAt)).toEqual([
      instant(3000),
    ]);
    if (outcome.kind !== "completed") {
      throw new Error("expected a completed wake");
    }
    expect(outcome.report.recovery).toMatchObject({
      phase: "recovery",
      status: "completed",
      code: "COMPLETED",
      examined: 0,
    });
    expect(outcome.report.expiredCleanup).toMatchObject({ status: "completed", removed: 0 });
    expect(outcome.report.finishedCollection).toMatchObject({ status: "completed", removed: 0 });
    expect(outcome.report.dispatch).toMatchObject({
      status: "completed",
      code: "COMPLETED",
      examined: 1,
      dispatched: 1,
    });
    expect(Object.isFrozen(outcome.report)).toBe(true);
    expect(harnessed.timers.scheduled).toEqual([SCHEDULED_MAINTENANCE_DEADLINE_MS]);
    expect(harnessed.timers.cleared()).toBe(1);
    expect(harnessed.timers.active()).toBe(0);
  });

  it("preserves an application phase failure instead of a fabricated zero", async () => {
    const harnessed = harness({
      recovery: async () => {
        throw new StoreUnavailable("recovery unavailable");
      },
    });

    const outcome = await harnessed.wake({ limits: LIMITS });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      throw new Error("expected a completed wake");
    }
    expect(outcome.report.recovery).toEqual({
      phase: "recovery",
      status: "failed",
      code: "STORE_UNAVAILABLE",
      examined: null,
      staleClaimsMarkedUnknown: null,
      jobsRearmed: null,
      jobsDeadLettered: null,
      skipped: null,
    });
    // Later phases still ran and reported their own real counts.
    expect(harnessed.calls).toEqual(["recovery", "expired_cleanup", "finished_collection"]);
    expect(outcome.report.expiredCleanup).toMatchObject({ status: "completed", removed: 0 });
    expect(outcome.report.dispatch.status).toBe("completed");
    expect(harnessed.timers.cleared()).toBe(1);
    expect(harnessed.timers.active()).toBe(0);
  });

  it("fails cause-free with INVALID_OPTIONS before any call or timer", async () => {
    const cases: readonly ScheduledMaintenanceOptions[] = [
      {} as ScheduledMaintenanceOptions,
      { limits: { ...LIMITS, recoveryLimit: 0 } },
      { limits: { ...LIMITS, cleanupLimit: 2.5 } },
      { limits: { ...LIMITS, collectionLimit: -1 } },
      { limits: { ...LIMITS, dispatchLimit: Number.NaN } },
      { limits: { recoveryLimit: 1, cleanupLimit: 1, collectionLimit: 1 } as never },
      { limits: LIMITS, deadlineMs: 0 },
      { limits: LIMITS, deadlineMs: -1 },
      { limits: LIMITS, deadlineMs: Number.NaN },
      { limits: LIMITS, deadlineMs: SCHEDULED_MAINTENANCE_DEADLINE_MS + 1 },
    ];

    for (const options of cases) {
      const fake = createSnapshotFake();
      const harnessed = harness();
      const outcome = await harnessed.wake(options);
      expect(outcome).toEqual({ kind: "failed", code: "INVALID_OPTIONS" });
      expect(harnessed.calls).toEqual([]);
      expect(harnessed.timers.scheduled).toEqual([]);
      expect(harnessed.timers.active()).toBe(0);
      expect(fake.snapshot().posts).toEqual([]);
    }
  });

  it("accepts a lower deadline option and rejects anything above the fixed deadline", async () => {
    const lower = harness();
    const lowerOutcome = await lower.wake({ limits: LIMITS, deadlineMs: 5000 });
    expect(lowerOutcome.kind).toBe("completed");
    expect(lower.timers.scheduled).toEqual([5000]);

    const exact = harness();
    expect((await exact.wake({ limits: LIMITS, deadlineMs: SCHEDULED_MAINTENANCE_DEADLINE_MS })).kind).toBe(
      "completed",
    );
    expect(exact.timers.scheduled).toEqual([SCHEDULED_MAINTENANCE_DEADLINE_MS]);

    const above = harness();
    expect(await above.wake({ limits: LIMITS, deadlineMs: SCHEDULED_MAINTENANCE_DEADLINE_MS + 1 })).toEqual(
      { kind: "failed", code: "INVALID_OPTIONS" },
    );
    expect(above.timers.scheduled).toEqual([]);
  });
});

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("scheduled maintenance deadline", () => {
  it("returns timed_out for a held-open recovery and starts no later phase after it settles", async () => {
    for (const settle of ["resolve", "reject"] as const) {
      let settleRecovery: ((mode: "resolve" | "reject") => void) | null = null;
      const harnessed = harness({
        recovery: async () =>
          new Promise<RecoveryResult>((resolve, reject) => {
            settleRecovery = (mode) => {
              if (mode === "reject") {
                reject(new StoreUnavailable(`late recovery failure ${SENTINEL}`));
              } else {
                resolve(EMPTY_RECOVERY);
              }
            };
          }),
      });

      const outcome = await harnessed.wake({ limits: LIMITS, deadlineMs: 25 });

      expect(outcome, settle).toEqual({ kind: "timed_out" });
      expect(harnessed.calls, settle).toEqual(["recovery"]);
      expect(harnessed.timers.scheduled, settle).toEqual([25]);
      expect(harnessed.timers.cleared(), settle).toBe(1);
      expect(harnessed.timers.active(), settle).toBe(0);

      settleRecovery!(settle === "reject" ? "reject" : "resolve");
      await tick();
      // The accepted work may still settle, but no later phase may start and
      // nothing may surface as a raw late rejection.
      expect(harnessed.calls, settle).toEqual(["recovery"]);
    }
  });

  it("returns timed_out while the first send is held and never starts a second send", async () => {
    let releaseSend: (() => void) | null = null;
    let sends = 0;
    const queue = {
      async send(message: QueueEnvelopeV1): Promise<void> {
        sends += 1;
        if (sends === 1) {
          await new Promise<void>((resolve) => {
            releaseSend = resolve;
          });
        }
        await fake.queue.send(message);
      },
    };
    const harnessed = harness({ queue });
    const fake = harnessed.fake;
    await seedDueJobs(fake, 2);

    const outcome = await harnessed.wake({
      limits: { ...LIMITS, dispatchLimit: 20 },
      deadlineMs: 25,
    });

    expect(outcome).toEqual({ kind: "timed_out" });
    expect(sends).toBe(1);
    expect(harnessed.timers.cleared()).toBe(1);

    releaseSend!();
    await tick();
    // The accepted send finished and its own mark landed; no second send began.
    expect(sends).toBe(1);
    expect(fake.snapshot().jobs.filter((job) => job.status === "dispatched")).toHaveLength(1);
    expect(fake.snapshot().jobs.filter((job) => job.status === "pending")).toHaveLength(1);
    expect(fake.sentEnvelopes).toHaveLength(1);
  });

  it("keeps independent stop and deadline state across concurrent wakes", async () => {
    const hanging = harness({
      recovery: async () => new Promise<RecoveryResult>(() => undefined),
    });
    const normal = harness();

    const [timedOut, completed] = await Promise.all([
      hanging.wake({ limits: LIMITS, deadlineMs: 25 }),
      normal.wake({ limits: LIMITS }),
    ]);

    expect(timedOut).toEqual({ kind: "timed_out" });
    expect(completed.kind).toBe("completed");
    expect(normal.calls).toEqual(["recovery", "expired_cleanup", "finished_collection"]);
    expect(hanging.timers.scheduled).toEqual([25]);
    expect(normal.timers.scheduled).toEqual([SCHEDULED_MAINTENANCE_DEADLINE_MS]);
    expect(hanging.timers.cleared()).toBe(1);
    expect(normal.timers.cleared()).toBe(1);
  });

  it("treats elapsed time as a deadline even when the timer callback never fires", async () => {
    let reads = 0;
    const harnessed = harness({
      // Start and the first continuation check are inside the deadline; any
      // later check is far past it while the twenty-second timer is still armed.
      monotonicNow: () => {
        reads += 1;
        return reads <= 2 ? 0 : 1_000_000;
      },
    });

    const outcome = await harnessed.wake({ limits: LIMITS });

    expect(outcome).toEqual({ kind: "timed_out" });
    expect(harnessed.calls).toEqual(["recovery"]);
    expect(harnessed.timers.scheduled).toEqual([SCHEDULED_MAINTENANCE_DEADLINE_MS]);
    expect(harnessed.timers.cleared()).toBe(1);
  });

  it("returns timed_out when a last phase finishes after elapsed time with no timer callback", async () => {
    let elapsed = false;
    const harnessed = harness({
      monotonicNow: () => (elapsed ? 1_000_000 : 0),
      queue: {
        async send(): Promise<void> {
          // The final phase's work completes only after the deadline elapsed.
          elapsed = true;
        },
      },
    });
    await seedDueJobs(harnessed.fake, 1);

    const outcome = await harnessed.wake({ limits: LIMITS });

    expect(outcome).toEqual({ kind: "timed_out" });
    // The twenty-second timer never fired: elapsed time alone decided, and the
    // timed-out outcome carries no invented phase counts.
    expect(harnessed.timers.scheduled).toEqual([SCHEDULED_MAINTENANCE_DEADLINE_MS]);
    expect(harnessed.timers.cleared()).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain("examined");
  });

  it("keeps a caller continuation stop distinct from a deadline", async () => {
    let checks = 0;
    const harnessed = harness({
      shouldContinue: () => {
        checks += 1;
        return checks <= 2;
      },
    });

    const outcome = await harnessed.wake({ limits: LIMITS });

    // The caller stop ends work but is not a deadline: the real report stands.
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      throw new Error("expected a completed wake");
    }
    expect(harnessed.calls).toEqual(["recovery", "expired_cleanup"]);
    expect(outcome.report.finishedCollection).toMatchObject({
      status: "skipped",
      code: "BUDGET_EXHAUSTED",
      removed: null,
    });
    expect(outcome.report.dispatch).toMatchObject({ status: "skipped", sent: null });
  });

  it("caps an explicit dispatch budget above twenty through the accepted dispatcher", async () => {
    const harnessed = harness();
    await seedDueJobs(harnessed.fake, 25);
    const fake = harnessed.fake;

    const outcome = await harnessed.wake({ limits: { ...LIMITS, dispatchLimit: 50 } });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      throw new Error("expected a completed wake");
    }
    expect(outcome.report.dispatch.examined).toBe(20);
    expect(outcome.report.dispatch.dispatched).toBe(20);
    expect(fake.sentEnvelopes).toHaveLength(20);
  });
});

describe("scheduled maintenance capture and wiring failures", () => {
  it("uses the captured dependency, predicate and timer references after container mutation", async () => {
    const captured = createSnapshotFake();
    const mutated = createSnapshotFake();
    let capturedRecoveries = 0;
    let mutatedRecoveries = 0;
    let capturedChecks = 0;
    let mutatedChecks = 0;
    const recorder = timerRecorder();
    const otherRecorder = timerRecorder();

    const dependencies: ScheduledMaintenanceDependencies = {
      publishing: {
        async recoverStaleClaims(budget: MaintenanceBudget): Promise<RecoveryResult> {
          capturedRecoveries += 1;
          return captured.publishing.recoverStaleClaims(budget);
        },
      },
      credentials: {
        async cleanupExpired(budget: MaintenanceBudget): Promise<CleanupResult> {
          return captured.credentials.cleanupExpired(budget);
        },
      },
      outbox: { ...captured.outbox },
      queue: captured.queue,
      clock: { now: () => FIXTURE_NOW },
      shouldContinue: () => {
        capturedChecks += 1;
        return true;
      },
      timers: recorder.timers,
    };
    const wake = createScheduledMaintenance(dependencies);

    // Mutate the caller's container after construction.
    const mutable = dependencies as unknown as Record<string, unknown>;
    mutable["publishing"] = {
      async recoverStaleClaims(): Promise<RecoveryResult> {
        mutatedRecoveries += 1;
        return EMPTY_RECOVERY;
      },
    };
    mutable["shouldContinue"] = () => {
      mutatedChecks += 1;
      return false;
    };
    mutable["timers"] = otherRecorder.timers;
    mutable["clock"] = {
      now(): string {
        throw new Error(`mutated clock ${SENTINEL}`);
      },
    };

    const outcome = await wake({ limits: LIMITS });

    expect(outcome.kind).toBe("completed");
    expect(capturedRecoveries).toBe(1);
    expect(mutatedRecoveries).toBe(0);
    expect(capturedChecks).toBeGreaterThan(0);
    expect(mutatedChecks).toBe(0);
    expect(recorder.scheduled).toEqual([SCHEDULED_MAINTENANCE_DEADLINE_MS]);
    expect(otherRecorder.scheduled).toEqual([]);
    expect(mutated.snapshot().posts).toEqual([]);
  });

  it("fails cause-free when the monotonic source is invalid or throws", async () => {
    const invalid: readonly (() => number)[] = [
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
      () => {
        throw new Error(`monotonic source ${SENTINEL}`);
      },
    ];

    for (const monotonicNow of invalid) {
      const harnessed = harness({ monotonicNow });
      const outcome = await harnessed.wake({ limits: LIMITS });
      expect(outcome).toEqual({ kind: "failed", code: "MAINTENANCE_FAILED" });
      expect(harnessed.calls).toEqual([]);
      // The clock read precedes the timer, so nothing was armed.
      expect(harnessed.timers.scheduled).toEqual([]);
      expect(harnessed.timers.active()).toBe(0);
      expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    }
  });

  it("fails cause-free when a later monotonic read is unusable", async () => {
    let reads = 0;
    const harnessed = harness({
      monotonicNow: () => {
        reads += 1;
        if (reads > 2) {
          throw new Error(`later monotonic failure ${SENTINEL}`);
        }
        return 0;
      },
    });

    const outcome = await harnessed.wake({ limits: LIMITS });

    // Unmeasurable time is a fixed failure, not a proven deadline; the latched
    // stop still prevents every later phase.
    expect(outcome).toEqual({ kind: "failed", code: "MAINTENANCE_FAILED" });
    expect(harnessed.calls).toEqual(["recovery"]);
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(harnessed.timers.cleared()).toBe(1);
  });

  it("handles timer setup and cleanup failures without leaking raw errors", async () => {
    const setupFailure = harness({
      timers: {
        set: (): never => {
          throw new Error(`timer set failure ${SENTINEL}`);
        },
        clear: (): void => undefined,
      },
    });
    const setupOutcome = await setupFailure.wake({ limits: LIMITS });
    expect(setupOutcome).toEqual({ kind: "failed", code: "MAINTENANCE_FAILED" });
    // Timer setup precedes every domain call.
    expect(setupFailure.calls).toEqual([]);
    expect(JSON.stringify(setupOutcome)).not.toContain(SENTINEL);

    const recorder = timerRecorder();
    let clearAttempts = 0;
    const clearFailure = harness({
      timers: {
        set: recorder.timers.set,
        clear: (): never => {
          clearAttempts += 1;
          throw new Error(`timer clear failure ${SENTINEL}`);
        },
      },
    });
    const clearOutcome = await clearFailure.wake({ limits: LIMITS });
    expect(clearOutcome.kind).toBe("completed");
    expect(clearFailure.calls).toEqual(["recovery", "expired_cleanup", "finished_collection"]);
    expect(JSON.stringify(clearOutcome)).not.toContain(SENTINEL);
    // The hook threw, so this proves the cleanup was *attempted* and the
    // outcome stayed intact; it does not prove the handle was really cleared.
    expect(clearAttempts).toBe(1);
  });
});
