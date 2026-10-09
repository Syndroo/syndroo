/**
 * Status-only polling for `@syndroo/sdk`.
 *
 * `wait` never publishes, never confirms and never resumes a credential step.
 * It polls exactly one query shape, `status({ type: "operation" })`, until the
 * current execution round is complete, and returns that round. A prepared
 * operation is not an execution round, so it yields a static
 * `CONFIRMATION_REQUIRED` / `CONFIRMATION_EXPIRED` error instead.
 *
 * Round completion is decided from delivery results, not from the aggregate
 * `status` string. An aggregate `unknown` is required to survive alongside
 * deliveries that are still unresolved (spec 6.4), so stopping on
 * `status === "unknown"` would return a round that is still sending to other
 * targets. The round is complete when every delivery has a resolved outcome.
 *
 * Timeout and cancellation end the local wait only. They never cancel server
 * work and never start a new publish.
 */

import { SyndrooError } from "./errors.js";
import type { ExecutionResult, OperationView, SleepLike, WaitOptions } from "./types.js";

/** Documented wait bounds. Changing one is an API decision. */
export const WAIT_LIMITS = Object.freeze({
  /** Poll interval when the caller does not choose one. */
  defaultIntervalMs: 2000,
  minIntervalMs: 250,
  maxIntervalMs: 30000,
  /** Total wait when the caller does not choose one. */
  defaultTimeoutMs: 120000,
  minTimeoutMs: 1,
  maxTimeoutMs: 3600000,
});

/** The terminal current execution round returned by `wait`. */
export type WaitResult = ExecutionResult;

export type WaitDependencies = {
  /** Read one operation view. Must be `status({ type: "operation" })` only. */
  readonly readOperation: (
    operationId: string,
    signal: AbortSignal | undefined,
  ) => Promise<OperationView>;
  /** Delay between polls, cancellation-aware. */
  readonly sleep: SleepLike;
  /** Clock, injectable so tests do not depend on wall time. */
  readonly now?: () => number;
};

function assertIntegerInRange(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SyndrooError("INVALID_ARGUMENT");
  }
  return value;
}

function resolveWaitOptions(options: WaitOptions): {
  intervalMs: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
} {
  const intervalMs =
    options.intervalMs === undefined
      ? WAIT_LIMITS.defaultIntervalMs
      : assertIntegerInRange(options.intervalMs, WAIT_LIMITS.minIntervalMs, WAIT_LIMITS.maxIntervalMs);
  const timeoutMs =
    options.timeoutMs === undefined
      ? WAIT_LIMITS.defaultTimeoutMs
      : assertIntegerInRange(options.timeoutMs, WAIT_LIMITS.minTimeoutMs, WAIT_LIMITS.maxTimeoutMs);
  return { intervalMs, timeoutMs, signal: options.signal };
}

/**
 * A round is complete when every delivery has resolved.
 *
 * `outcome: null` means "this target is not resolved yet", which is exactly the
 * case an aggregate `unknown` can hide. A round with no deliveries at all has
 * nothing to resolve, so only an aggregate terminal status can end it.
 */
export function isExecutionRoundComplete(round: ExecutionResult): boolean {
  if (round.deliveries.length === 0) {
    return round.status !== "pending" && round.status !== "running";
  }
  return round.deliveries.every((delivery) => delivery.outcome !== null);
}

/**
 * The default injected sleep: timer-backed and cancellation-aware.
 *
 * The timer stays referenced. Between two polls this timer is often the only
 * thing keeping the Node event loop alive, so unreferencing it would let a real
 * process exit (13) before the wait completed or timed out.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SyndrooError("ABORTED"));
      return;
    }
    if (!Number.isFinite(ms) || ms < 0) {
      reject(new SyndrooError("INVALID_ARGUMENT"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new SyndrooError("ABORTED"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Merge cancellation signals into one, so a single value guards the whole wait. */
function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length === 1) {
    return present[0];
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

/**
 * Poll until the current execution round completes, then return it.
 *
 * Throws `CONFIRMATION_REQUIRED` / `CONFIRMATION_EXPIRED` for a prepared
 * operation, `WAIT_TIMEOUT` when the deadline elapses, and `ABORTED` when the
 * caller cancels. Nothing here sends content.
 */
export async function waitForExecutionRound(
  deps: WaitDependencies,
  operationId: string,
  options: WaitOptions = {},
): Promise<WaitResult> {
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new SyndrooError("INVALID_ARGUMENT");
  }
  const { intervalMs, timeoutMs, signal } = resolveWaitOptions(options);
  const injectedNow = deps.now;
  const now = injectedNow ?? ((): number => Date.now());
  const deadline = now() + timeoutMs;

  /*
   * One deadline, two effects: it is checked before every poll and before any
   * result is returned, and it also aborts whatever is in flight - the status
   * request or the sleep - so a slow poll cannot push the wait past its budget.
   *
   * A real clock gets a real abort timer. An injected clock is driven by the
   * test through `now()`, so no wall-clock timer is left dangling behind it.
   */
  const deadlineController = new AbortController();
  let deadlineElapsed = false;
  const timer =
    injectedNow === undefined
      ? setTimeout(() => {
          deadlineElapsed = true;
          deadlineController.abort();
        }, timeoutMs)
      : undefined;
  const pollSignal = combineSignals([signal, deadlineController.signal]);
  const deadlineReached = (): boolean => deadlineElapsed || now() >= deadline;
  const timeoutError = (): SyndrooError => new SyndrooError("WAIT_TIMEOUT");

  try {
    for (;;) {
      if (signal?.aborted === true) {
        throw new SyndrooError("ABORTED");
      }
      if (deadlineReached()) {
        throw timeoutError();
      }
      let view: OperationView;
      try {
        view = await deps.readOperation(operationId, pollSignal);
      } catch (error) {
        if (deadlineElapsed) {
          throw timeoutError();
        }
        throw error;
      }
      if (deadlineReached()) {
        throw timeoutError();
      }
      if (view.phase === "prepared") {
        throw new SyndrooError(
          view.confirmation === "expired" ? "CONFIRMATION_EXPIRED" : "CONFIRMATION_REQUIRED",
        );
      }
      if (isExecutionRoundComplete(view)) {
        return view;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw timeoutError();
      }
      try {
        await deps.sleep(Math.min(intervalMs, remaining), pollSignal);
      } catch (error) {
        if (deadlineElapsed) {
          throw timeoutError();
        }
        throw error;
      }
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
