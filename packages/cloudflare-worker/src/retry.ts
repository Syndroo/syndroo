import type { PublishError } from "@syndroo/core";

export const MAX_ATTEMPTS = 3;

/**
 * Seconds to wait before the next attempt, derived from the attempts already
 * made. First retry waits 60 seconds, second waits 120 seconds.
 *
 * Keep this rule in sync with RETRY_DELAY_SECONDS_SQL in repository.ts, which
 * derives the same delay inside the failure transaction.
 */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 15 * 60);
}

/**
 * Only explicitly retryable, unambiguous failures retry below the attempt cap.
 * Ambiguous outcomes (timeouts, connection loss, provider 5xx after submission)
 * are never retried automatically.
 */
export function shouldRetry(error: PublishError, attempts: number): boolean {
  if (error.ambiguous || attempts >= MAX_ATTEMPTS) {
    return false;
  }

  return (
    error.code === "RATE_LIMIT" ||
    error.code === "PROVIDER_UNAVAILABLE" ||
    error.code === "NETWORK"
  );
}

/**
 * Earliest time the next attempt may run. Persisted with the failure so Queue
 * duplicates and Cron selection both respect the same instant.
 */
export function retryAtFor(now: string, attempts: number): string {
  return new Date(
    Date.parse(now) + retryDelaySeconds(attempts) * 1000,
  ).toISOString();
}

/** Whole seconds to wait until `retryAt`; never shorter than one second. */
export function secondsUntilRetry(retryAt: string, nowMs: number): number {
  return Math.max(1, Math.ceil((Date.parse(retryAt) - nowMs) / 1000));
}
