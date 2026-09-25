import type {
  LocalProviderId,
  ProviderOutcome,
  TargetStatus,
} from "@syndroo/core";

import { EXIT_CODE, type ExitCode } from "../exit-codes.js";
import type { PlanAction } from "./ports/local-store.js";

/** Frozen connection identity shown in a preview; never a token or fingerprint. */
export interface LocalResultBinding {
  readonly connectionId: string;
  readonly bindingRevision: number;
}

/** One previewed target of a frozen plan. */
export interface LocalPlanItemResult {
  readonly key: string;
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly action: PlanAction;
  readonly content: string;
  readonly binding: LocalResultBinding;
  readonly previousBinding: LocalResultBinding | null;
}

/** `publish --dry-run` / `retry --dry-run` payload. */
export interface LocalPreviewResult {
  readonly planId: string;
  readonly expiresAt: string;
  readonly digest: string;
  readonly items: readonly LocalPlanItemResult[];
}

export type LocalWriteDisposition = "applied" | "not_applied" | "unknown";

/** Why a target may or may not be retried, as reported to the operator. */
export interface LocalRetryAdvice {
  readonly eligible: boolean;
  readonly reason: LocalRetryReason;
  readonly notBefore: string | null;
}

/** The fixed reason vocabulary of `retry` in one target's result. */
export type LocalRetryReason =
  | "ALREADY_SUCCEEDED"
  | "NOT_STARTED"
  | "CONFIRMED_NOT_SENT"
  | "OUTCOME_UNKNOWN"
  | "PERMANENT_FAILURE"
  | "ATTEMPTS_EXHAUSTED"
  | "RETRY_NOT_READY";

/** Content attempts one logical delivery may ever use, across plans. */
export const LOCAL_CONTENT_ATTEMPT_LIMIT = 3;

/** One selected target after execution or a receipt read. */
export interface LocalTargetResult {
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly status: TargetStatus;
  readonly reused: boolean;
  readonly attempts: number;
  readonly remoteId: string | null;
  readonly url: string | null;
  readonly writeDisposition: LocalWriteDisposition;
  readonly retry: LocalRetryAdvice;
}

/**
 * Aggregate status of a run.
 *
 * This is a post-admission view: a pure preflight refusal is raised as a
 * `CliError` (exit 2) before any execution result exists, so it never reaches
 * this type. `blocked` here means the run was admitted and no target was
 * attempted at all (for example the deadline passed before the first target),
 * which is confirmed non-delivery and exits 6.
 */
export type LocalAggregateStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "unknown"
  | "blocked";

export interface LocalExecutionResult {
  readonly operationId: string;
  readonly planId: string;
  readonly status: LocalAggregateStatus;
  readonly durability: "committed" | "failed";
  readonly interrupted?: boolean;
  readonly results: readonly LocalTargetResult[];
}

/**
 * What one target's status means for the write itself.
 *
 * `in_flight` is an unknown write: the request stage has not committed an
 * answer, so nothing may claim it was not applied.
 */
export function writeDispositionFor(status: TargetStatus): LocalWriteDisposition {
  if (status === "succeeded") {
    return "applied";
  }

  if (status === "failed" || status === "not_started") {
    return "not_applied";
  }

  return "unknown";
}

/**
 * What the operator may do next with one target.
 *
 * `eligible` means an explicit retry would be admitted right now: a permanent
 * failure, an exhausted attempt budget, an unknown or unfinished write, and a
 * window that has not opened yet are all reported as ineligible with the
 * reason. This is the single implementation both execution results and
 * read-only receipts use.
 */
export function retryAdviceFor(
  status: TargetStatus,
  outcome: ProviderOutcome | null,
  attempts: number,
  now: Date,
): LocalRetryAdvice {
  if (status === "succeeded") {
    return { eligible: false, reason: "ALREADY_SUCCEEDED", notBefore: null };
  }

  if (status === "unknown" || status === "in_flight") {
    return { eligible: false, reason: "OUTCOME_UNKNOWN", notBefore: null };
  }

  if (status === "not_started") {
    return { eligible: true, reason: "NOT_STARTED", notBefore: null };
  }

  if (attempts >= LOCAL_CONTENT_ATTEMPT_LIMIT) {
    return { eligible: false, reason: "ATTEMPTS_EXHAUSTED", notBefore: null };
  }

  if (
    outcome === null ||
    outcome.kind !== "failed" ||
    outcome.writeDisposition !== "not_applied" ||
    !outcome.retryable
  ) {
    return { eligible: false, reason: "PERMANENT_FAILURE", notBefore: null };
  }

  if (
    outcome.retryNotBefore !== null &&
    Date.parse(outcome.retryNotBefore) > now.getTime()
  ) {
    return {
      eligible: false,
      reason: "RETRY_NOT_READY",
      notBefore: outcome.retryNotBefore,
    };
  }

  return { eligible: true, reason: "CONFIRMED_NOT_SENT", notBefore: null };
}

export interface TargetResultInput {
  readonly provider: LocalProviderId;
  readonly targetId: string;
  /** The status to report. Execution maps `in_flight` to unknown; receipts may keep it. */
  readonly status: TargetStatus;
  readonly attempts: number;
  readonly outcome: ProviderOutcome | null;
  readonly reused: boolean;
  readonly now: Date;
}

/**
 * One target's result row, from whatever the caller knows.
 *
 * Both the execution path and read-only receipts build their rows here, so a
 * receipt can never disagree with execution about disposition or retry advice.
 */
export function targetResultOf(input: TargetResultInput): LocalTargetResult {
  const succeeded = input.status === "succeeded";

  return {
    provider: input.provider,
    targetId: input.targetId,
    status: input.status,
    reused: input.reused,
    attempts: input.attempts,
    remoteId: succeeded && input.outcome?.kind === "succeeded"
      ? input.outcome.remoteId
      : null,
    url: succeeded && input.outcome?.kind === "succeeded"
      ? input.outcome.url
      : null,
    writeDisposition: writeDispositionFor(input.status),
    retry: retryAdviceFor(
      input.status,
      input.outcome,
      input.attempts,
      input.now,
    ),
  };
}

/**
 * Aggregate one run following `04` §5.
 *
 * An active or orphaned `in_flight` target is reported as `unknown`: the CLI
 * cannot prove the write either landed or did not.
 */
export function aggregateStatus(
  results: readonly LocalTargetResult[],
): LocalAggregateStatus {
  if (results.length === 0) {
    return "blocked";
  }

  if (
    results.some(
      result => result.status === "unknown" || result.status === "in_flight",
    )
  ) {
    return "unknown";
  }

  if (results.every(result => result.status === "succeeded")) {
    return "succeeded";
  }

  if (results.some(result => result.status === "succeeded")) {
    return "partial";
  }

  if (results.some(result => result.status === "failed")) {
    return "failed";
  }

  return "blocked";
}

/**
 * Exit code for one admitted run that has finished executing, following `04` §6.
 *
 * Post-admission only: a pure admission failure is raised as a `CliError` with
 * exit 2 before any content request, and never reaches this helper. Priority
 * without a signal: unknown write (4) beats a durability failure (1), which
 * beats confirmed incomplete delivery (6), which beats success (0). An admitted
 * run whose deadline passed before the first attempt is incomplete, so the
 * `blocked` fallback is 6, not 2.
 */
export function exitCodeForResult(result: LocalExecutionResult): ExitCode {
  if (result.interrupted === true) {
    return EXIT_CODE.INTERRUPTED;
  }

  if (result.status === "unknown") {
    return EXIT_CODE.AMBIGUOUS;
  }

  if (result.durability === "failed") {
    return EXIT_CODE.FAILURE;
  }

  if (result.status === "succeeded") {
    return EXIT_CODE.SUCCESS;
  }

  return EXIT_CODE.NOT_DELIVERED;
}
