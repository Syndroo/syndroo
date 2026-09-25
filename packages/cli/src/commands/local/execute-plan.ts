import { EXIT_CODE } from "../../exit-codes.js";
import { credentialResolver, type LocalRuntime } from "../../local/composition.js";
import type { PlanKind } from "../../local/ports/local-store.js";
import {
  exitCodeForResult,
  type LocalExecutionResult,
} from "../../local/results.js";
import { LocalLockReleaseError } from "../../local/state/lock.js";
import { withLocalWriteLock } from "../../local/state/store.js";
import type { CommandContext } from "../context.js";
import { safeDiagnostic, type LocalCommandOutcome } from "./shared.js";

/**
 * Executes one already-confirmed frozen plan.
 *
 * The global write lock is held for the whole run, so two invocations cannot
 * both admit the same plan. The execution module is imported lazily so the
 * legacy remote commands never load it.
 */
export async function executeFrozenPlan(
  context: CommandContext,
  runtime: LocalRuntime,
  planId: string,
  kind: PlanKind,
  timeoutMs: number,
): Promise<LocalCommandOutcome> {
  const { executeLocalPlan } = await import("../../local/execute.js");
  const resolveCredentials = credentialResolver(context, runtime);

  let result: LocalExecutionResult;
  let lockFailure = false;

  try {
    result = await withLocalWriteLock(runtime.stateHome, () =>
      executeLocalPlan(planId, {
        store: runtime.store,
        providers: runtime.providers,
        resolveCredentials,
        signal: context.io.signal,
        kind,
        now: runtime.clock,
        timeoutMs,
      }),
    );
  } catch (error) {
    if (error instanceof LocalLockReleaseError) {
      // The run finished; only the cleanup failed. Keep its evidence and report
      // a non-zero durability failure instead of pretending nothing happened.
      result = error.result as LocalExecutionResult;
      lockFailure = true;
    } else {
      throw error;
    }
  }

  return executionOutcome(context, kind, result, lockFailure);
}

/** Maps one finished run onto the envelope, exit code, and human summary. */
export function executionOutcome(
  context: CommandContext,
  kind: PlanKind,
  result: LocalExecutionResult,
  lockFailure: boolean,
): LocalCommandOutcome {
  // A lock that could not be released is a durability failure: the outcome is
  // still what the providers reported, but the run cannot be called clean.
  const effective: LocalExecutionResult = lockFailure
    ? { ...result, durability: "failed" }
    : result;
  const ok =
    effective.status === "succeeded" && effective.durability === "committed";
  let diagnosticsOk = true;
  const unknownProviders = effective.results
    .filter(target => target.status === "unknown" || target.status === "in_flight")
    .map(target => target.provider);
  const notDeliveredProviders = effective.results
    .filter(target => target.status !== "succeeded")
    .map(target => target.provider);

  for (const target of effective.results) {
    if (target.status === "unknown" || target.status === "in_flight") {
      diagnosticsOk =
        safeDiagnostic(
          context.reporter,
          `${target.provider}: the write result is unknown; read the receipt before retrying`,
        ) && diagnosticsOk;
    }
  }

  if (lockFailure) {
    diagnosticsOk =
      safeDiagnostic(
        context.reporter,
        "the local write lock could not be released; the outcome above is this process's own evidence and the on-disk state may differ",
      ) && diagnosticsOk;
  }

  if (effective.durability === "failed" && !lockFailure) {
    diagnosticsOk =
      safeDiagnostic(
        context.reporter,
        "a trusted provider result could not be persisted; the state may need recovery",
      ) && diagnosticsOk;
  }

  // A result this process cannot report is not a clean success. The exit code
  // stays non-zero and the signal/unknown precedence is preserved.
  const exitCode = diagnosticsOk
    ? exitCodeForResult(effective)
    : context.io.signal.aborted
      ? EXIT_CODE.INTERRUPTED
      : effective.status === "unknown"
        ? EXIT_CODE.AMBIGUOUS
        : EXIT_CODE.FAILURE;

  const error =
    (ok && diagnosticsOk)
      ? undefined
      : !diagnosticsOk
        ? {
            code: "STATE_COMMIT_FAILED",
            message:
              "the local result could not be reported completely; read the receipt before retrying",
            details: {
              status: effective.status,
              durability: effective.durability,
            },
          }
        : effective.interrupted === true
        ? {
            code: "INTERRUPTED",
            message:
              "the local process stopped on a signal; the result above is what this process knew when it stopped",
            details: {
              status: effective.status,
              durability: effective.durability,
              interrupted: true,
            },
          }
        : effective.status === "unknown"
        ? {
            code: "OUTCOME_UNKNOWN",
            message:
              "at least one write result is unknown; read the receipt before retrying",
            details: {
              status: effective.status,
              durability: effective.durability,
              lockFailure,
              unknownProviders,
            },
          }
        : effective.durability === "failed"
          ? {
              code: "STATE_COMMIT_FAILED",
              message:
                "a trusted result could not be committed durably; do not resend it",
              details: {
                status: effective.status,
                durability: effective.durability,
                lockFailure,
              },
            }
          : {
              code: "NOT_DELIVERED",
              message: "the run did not deliver every selected target",
              details: {
                status: effective.status,
                durability: effective.durability,
                notDeliveredProviders,
              },
            };

  return {
    ok: ok && diagnosticsOk,
    result: effective,
    human: [
      `syndroo ${kind} --plan`,
      `  operation  ${effective.operationId}`,
      `  status     ${effective.status}`,
      `  durability ${effective.durability}`,
      ...effective.results.map(
        target =>
          `  target     ${target.provider} ${target.targetId} ${target.status} attempts ${target.attempts}${
            target.remoteId === null ? "" : ` remote ${target.remoteId}`
          }`,
      ),
    ],
    exitCode,
    ...(error === undefined ? {} : { error }),
  };
}
