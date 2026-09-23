/**
 * Scheduled-runtime deadline wrapper around the accepted `runMaintenance`.
 *
 * Design §7 "Scheduled work and diagnostics" (independent scheduled-runner
 * slice): each wake gets one twenty-second total runtime deadline, an optional
 * internal test option may only *lower* it, every dependency reference is copied
 * before any work starts, and completion is raced against the deadline so a
 * held-open binding can never hold the runtime wrapper indefinitely.
 *
 * What a deadline does and does not establish:
 *
 * - it stops *starting* later phases and new sends, because the latched
 *   continuation check is handed to the accepted application;
 * - it does **not** cancel a D1 mutation or a broker send already accepted: that
 *   work keeps running, may still finish, and its eventual rejection is observed
 *   so it cannot surface as an unhandled rejection;
 * - the timed-out outcome deliberately carries **no** phase report: a wake that
 *   ran out of time has no authoritative counts, and inventing zeros or a
 *   partially successful report would misstate what happened;
 * - a completed outcome returns the application's own frozen report verbatim,
 *   including any phase that legitimately failed.
 *
 * This module adds no recovery, cleanup, collection or dispatch logic, chooses
 * no D1 query budget and does not touch `scheduler.ts` or the Worker entry.
 */

import {
  runMaintenance,
  type MaintenanceLimits,
  type MaintenanceReport,
  type RunMaintenanceDependencies,
} from "@syndroo/application";

/** Fixed total runtime deadline for one scheduled wake. */
export const SCHEDULED_MAINTENANCE_DEADLINE_MS = 20_000;

/** Fixed, cause-free failure codes for this wrapper. */
export type ScheduledMaintenanceErrorCode = "INVALID_OPTIONS" | "MAINTENANCE_FAILED";

export type ScheduledMaintenanceOutcome =
  | { readonly kind: "completed"; readonly report: MaintenanceReport }
  | { readonly kind: "timed_out" }
  | { readonly kind: "failed"; readonly code: ScheduledMaintenanceErrorCode };

export interface ScheduledMaintenanceOptions {
  /** Explicitly supplied row limits; this wrapper never guesses a profile. */
  readonly limits: MaintenanceLimits;
  /** Internal test option; values above the fixed deadline are rejected. */
  readonly deadlineMs?: number;
}

/** Timer handle abstraction so tests can instrument set/clear without fakes. */
export type ScheduledMaintenanceTimerHandle = unknown;

export interface ScheduledMaintenanceTimers {
  readonly set: (handler: () => void, ms: number) => ScheduledMaintenanceTimerHandle;
  readonly clear: (handle: ScheduledMaintenanceTimerHandle) => void;
}

export interface ScheduledMaintenanceDependencies extends RunMaintenanceDependencies {
  /** Monotonic millisecond source; defaults to `performance.now()`. */
  readonly monotonicNow?: () => number;
  /** Timer hooks; defaults to `setTimeout`/`clearTimeout`. */
  readonly timers?: ScheduledMaintenanceTimers;
}

export type ScheduledMaintenanceWake = (
  options: ScheduledMaintenanceOptions,
) => Promise<ScheduledMaintenanceOutcome>;

const DEFAULT_TIMERS: ScheduledMaintenanceTimers = Object.freeze({
  set: (handler: () => void, ms: number): ScheduledMaintenanceTimerHandle =>
    setTimeout(handler, ms),
  clear: (handle: ScheduledMaintenanceTimerHandle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

const defaultMonotonicNow = (): number => performance.now();

/**
 * Capture the dependency references once and return the per-wake function.
 *
 * Every port, the clock, the logger, the caller's continuation predicate, the
 * monotonic source and both timer functions are copied here, so mutating the
 * caller's container afterwards cannot change this wake. The captured values
 * are trusted runtime configuration: their getters are read at construction,
 * outside the wake's failure channel. All mutable wake state
 * (stop latch, deadline latch, timer handle) lives inside one invocation, so
 * concurrent wakes keep independent state.
 */
export function createScheduledMaintenance(
  dependencies: ScheduledMaintenanceDependencies,
): ScheduledMaintenanceWake {
  const publishing = dependencies.publishing;
  const credentials = dependencies.credentials;
  const outbox = dependencies.outbox;
  const queue = dependencies.queue;
  const clock = dependencies.clock;
  const logger = dependencies.logger;
  const callerShouldContinue = dependencies.shouldContinue;
  const monotonicNow = dependencies.monotonicNow ?? defaultMonotonicNow;
  const timers = dependencies.timers ?? DEFAULT_TIMERS;
  const timersSet = timers.set;
  const timersClear = timers.clear;

  return async (options: ScheduledMaintenanceOptions): Promise<ScheduledMaintenanceOutcome> => {
    let limits: MaintenanceLimits;
    let deadlineMs: number;
    try {
      limits = snapshotLimits(options?.limits);
      deadlineMs = readDeadlineMs(options?.deadlineMs);
      if (typeof timersSet !== "function" || typeof timersClear !== "function") {
        throw new Error("invalid timers");
      }
    } catch {
      // Fixed configuration failure, before any domain work or timer.
      return Object.freeze({ kind: "failed" as const, code: "INVALID_OPTIONS" as const });
    }

    let stopped = false;
    let deadlineExceeded = false;
    let clockFailed = false;
    let timer: ScheduledMaintenanceTimerHandle | null = null;

    const latchStop = (): void => {
      stopped = true;
    };
    const clearTimer = (): void => {
      if (timer === null) {
        return;
      }
      const handle = timer;
      timer = null;
      try {
        timersClear(handle);
      } catch {
        // A hostile timer hook must not change the reported outcome.
      }
    };
    /** Monotonic read with a fixed failure channel: never a raw rejection. */
    const readNow = (): number | null => {
      try {
        const value = monotonicNow();
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    };

    const startedAt = readNow();
    if (startedAt === null) {
      // An unusable monotonic source cannot schedule a bounded wake.
      latchStop();
      return Object.freeze({ kind: "failed" as const, code: "MAINTENANCE_FAILED" as const });
    }
    const deadlineAt = startedAt + deadlineMs;

    try {
      // Deadline observation is established BEFORE any domain call, so a timer
      // setup failure has zero domain effect. `timersSet` is deliberately called
      // outside the promise executor: a throw inside an executor would reject
      // the promise asynchronously instead of failing before the domain work.
      let resolveDeadline: (() => void) | null = null;
      const deadline = new Promise<"deadline">((resolve) => {
        resolveDeadline = () => resolve("deadline");
      });
      timer = timersSet(() => {
        // Latch the deadline before resolving the race.
        deadlineExceeded = true;
        latchStop();
        resolveDeadline?.();
      }, deadlineMs);

      // Latched continuation: a deadline (or a caller stop) is never undone, and
      // the accepted application consults this before every phase and send.
      const shouldContinue = (): boolean => {
        if (stopped) {
          return false;
        }
        const now = readNow();
        if (now === null) {
          // Unmeasurable time is a fixed failure, not a proven deadline: stop
          // starting work and report the wiring failure truthfully.
          clockFailed = true;
          latchStop();
          return false;
        }
        if (now >= deadlineAt) {
          // Elapsed time is a deadline even when the timer callback has not run.
          deadlineExceeded = true;
          latchStop();
          return false;
        }
        if (callerShouldContinue !== undefined) {
          try {
            if (callerShouldContinue() !== true) {
              // A caller stop is not a deadline: phases stop, the report stands.
              latchStop();
              return false;
            }
          } catch {
            latchStop();
            return false;
          }
        }
        return true;
      };

      const work = runMaintenance(limits, {
        publishing,
        credentials,
        outbox,
        queue,
        clock,
        ...(logger === undefined ? {} : { logger }),
        shouldContinue,
      });

      const raced = await Promise.race([
        work.then(
          (report) => Object.freeze({ kind: "completed" as const, report }),
          () => Object.freeze({ kind: "failed" as const }),
        ),
        deadline,
      ]);

      if (raced === "deadline" || deadlineExceeded) {
        // Latch BEFORE returning: later phases and new sends are refused, while
        // an already accepted mutation or send keeps running and is only
        // observed, never claimed as cancelled.
        latchStop();
        void work.then(
          () => undefined,
          () => undefined,
        );
        return Object.freeze({ kind: "timed_out" as const });
      }
      if (raced.kind === "failed") {
        // Fixed, cause-free: the application owns phase detail in its report.
        return Object.freeze({ kind: "failed" as const, code: "MAINTENANCE_FAILED" as const });
      }
      // The application can finish a last phase after the deadline elapsed while
      // its timer callback is still queued, with no further continuation check.
      // Re-read the monotonic clock before claiming a completed wake.
      const finishedAt = readNow();
      if (finishedAt === null || clockFailed) {
        latchStop();
        return Object.freeze({ kind: "failed" as const, code: "MAINTENANCE_FAILED" as const });
      }
      if (finishedAt >= deadlineAt) {
        latchStop();
        return Object.freeze({ kind: "timed_out" as const });
      }
      return Object.freeze({ kind: "completed" as const, report: raced.report });
    } catch {
      // Wiring or adapter failure (a throwing timer hook or a synchronous
      // application throw): one fixed failure, no raw detail. Dependency
      // references are captured as trusted configuration before any work.
      latchStop();
      return Object.freeze({ kind: "failed" as const, code: "MAINTENANCE_FAILED" as const });
    } finally {
      clearTimer();
    }
  };
}

/** Validate and copy the caller's explicit limits; no defaults exist. */
function snapshotLimits(limits: unknown): MaintenanceLimits {
  return Object.freeze({
    recoveryLimit: readPositiveLimit(limits, "recoveryLimit"),
    cleanupLimit: readPositiveLimit(limits, "cleanupLimit"),
    collectionLimit: readPositiveLimit(limits, "collectionLimit"),
    dispatchLimit: readPositiveLimit(limits, "dispatchLimit"),
  });
}

function readPositiveLimit(source: unknown, key: string): number {
  let value: unknown;
  try {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new Error("limits shape");
    }
    value = (source as Record<string, unknown>)[key];
  } catch {
    throw new Error(`invalid ${key}`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

/** Default twenty seconds; an internal option may only lower it. */
function readDeadlineMs(value: unknown): number {
  if (value === undefined) {
    return SCHEDULED_MAINTENANCE_DEADLINE_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > SCHEDULED_MAINTENANCE_DEADLINE_MS
  ) {
    throw new Error("invalid deadlineMs");
  }
  return value;
}
