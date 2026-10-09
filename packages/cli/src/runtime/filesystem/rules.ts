import { canonicalJson } from "@syndroo/core";
import type * as T from "@syndroo/core";

/**
 * Pure domain rules the local adapter needs for its own atomic transitions.
 *
 * Core's `domain/rules.ts` is the source of truth for these functions, but Core
 * does not publish them: the package root exports the record types, the wire
 * parser and the runtime only, and the package has no subpath export for the
 * internal module. Duplicating a handful of pure helpers keeps the adapter free
 * of deep private imports.
 *
 * `test/runtime/filesystem/rules.test.ts` runs every function here against
 * Core's implementation on the same inputs, so drift fails a test instead of
 * silently changing adapter behaviour.
 */

export const accountKey = (account: T.AccountIdentity): string =>
  canonicalJson(account);

export const later = (now: string, milliseconds: number): string =>
  new Date(Date.parse(now) + milliseconds).toISOString();

export const clone = <Value>(value: Value): Value => structuredClone(value);

export const unknownOutcome = (): T.ProviderWriteOutcome => ({
  status: "unknown",
  disposition: "unknown",
  reason: "unknown",
});

/**
 * Aggregate status: unresolved unknown dominates, then in-flight work, then
 * unclaimed work, then all-succeeded, then some-succeeded.
 */
export function aggregate(
  deliveries: readonly T.DeliveryRecord[],
): T.ExecutionStatus {
  if (deliveries.some(entry => entry.outcome?.status === "unknown")) {
    return "unknown";
  }

  if (deliveries.some(entry => entry.state === "in_flight")) {
    return "running";
  }

  if (deliveries.some(entry => entry.state === "ready")) {
    return "pending";
  }

  if (
    deliveries.length > 0 &&
    deliveries.every(entry => entry.outcome?.status === "succeeded")
  ) {
    return "succeeded";
  }

  return deliveries.some(entry => entry.outcome?.status === "succeeded")
    ? "partial"
    : "failed";
}

/** Pure retry eligibility: proved not-applied, retryable reason, attempts < 3. */
export function retryEligible(
  delivery: T.DeliveryRecord,
  now: string,
): boolean {
  if (delivery.state !== "settled" || delivery.attempts >= 3) {
    return false;
  }

  const outcome = delivery.outcome;

  if (!outcome) {
    return false;
  }

  if (outcome.status === "not_started") {
    return (
      outcome.reason === "cancelled_before_start" ||
      outcome.reason === "execution_interrupted" ||
      outcome.reason === "stale_binding" ||
      outcome.reason === "stale_implementation"
    );
  }

  return (
    outcome.status === "failed" &&
    outcome.disposition === "not_applied" &&
    outcome.retryable &&
    (outcome.reason === "network" ||
      outcome.reason === "rate_limited" ||
      outcome.reason === "provider_unavailable") &&
    (!outcome.retryAfter || Date.parse(outcome.retryAfter) <= Date.parse(now))
  );
}
