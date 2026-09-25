import type { TargetStatus } from "@syndroo/core";

import { configError, usageError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import {
  openLocalRuntime,
  requireNamespace,
  type LocalRunOverrides,
} from "../../local/composition.js";
import {
  LOCAL_ID_PATTERN,
  type DeliveryRecord,
  type LocalStore,
  type OperationRecord,
} from "../../local/ports/local-store.js";
import {
  aggregateStatus,
  type LocalAggregateStatus,
  type LocalTargetResult,
  targetResultOf,
} from "../../local/results.js";
import { localError } from "../../local/errors.js";
import { stateFailure } from "../../local/state/atomic.js";
import type { CommandContext } from "../context.js";
import {
  parseReceiptLimit,
  rejectTimeoutFlag,
  type LocalCommandOutcome,
} from "./shared.js";

/**
 * Receipts are read-only views of the authoritative records.
 *
 * They never query a platform, never repair a record, and never change an
 * `in_flight` marker: a query that could "fix" an unknown write would be worse
 * than reporting it honestly.
 */

async function readDeliveries(
  store: LocalStore,
  operation: OperationRecord,
): Promise<readonly DeliveryRecord[]> {
  const records: DeliveryRecord[] = [];

  for (const deliveryId of operation.deliveryIds) {
    const record = await store.getDelivery(deliveryId);

    if (record === null) {
      if (operation.admissionState === "preparing") {
        // Admission has not finished, so an undispatched record may simply not
        // exist yet. It is never reported as a delivery.
        continue;
      }

      // An admitted operation that lost an authoritative record is corrupt:
      // reporting an aggregate from the survivors would under-report a write.
      throw stateFailure(
        "STATE_CORRUPT",
        "an admitted operation is missing an authoritative delivery record",
      );
    }

    records.push(record);
  }

  return records;
}

/**
 * One authoritative record as the result schema describes a target.
 *
 * The mapping is the shared one from `results.ts`, so a receipt and an
 * execution can never disagree about a disposition or a retry window. The
 * record's own status is preserved, including `in_flight`; a durable
 * `in_flight` record is `unknown` for disposition purposes, never
 * `not_applied`.
 */
function targetResult(record: DeliveryRecord, now: Date): LocalTargetResult {
  return targetResultOf({
    provider: record.delivery.target.provider,
    targetId: record.delivery.target.targetId,
    status: record.status,
    attempts: record.attempts,
    outcome: record.outcome,
    // A reused success is not distinguishable from the record alone; the
    // execution path is where `reused` is known.
    reused: false,
    now,
  });
}

/**
 * An unpublished admission (`preparing`) is never reported as a delivery.
 *
 * No content request can happen before admission flips to `ready`, so a
 * preparing operation is `blocked`, and its not-yet-created records are simply
 * absent rather than invented.
 */
function operationStatus(
  operation: OperationRecord,
  records: readonly DeliveryRecord[],
  now: Date,
): LocalAggregateStatus {
  if (operation.admissionState === "preparing") {
    return "blocked";
  }

  return aggregateStatus(records.map(record => targetResult(record, now)));
}

function durabilityOf(
  operation: OperationRecord,
  records: readonly DeliveryRecord[],
): "committed" | "failed" {
  return records.length === operation.deliveryIds.length ? "committed" : "failed";
}

/** `syndroo receipts list` — read-only, newest first. */
export async function runReceiptsList(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  rejectTimeoutFlag(context);

  const limit = parseReceiptLimit(context);
  const runtime = await openLocalRuntime(context, overrides);
  const namespace = await requireNamespace(context, runtime);
  const operations = await runtime.store.listOperations(limit, namespace);
  const summaries: Record<string, unknown>[] = [];
  const now = runtime.clock();

  for (const operation of operations) {
    const records = await readDeliveries(runtime.store, operation);

    summaries.push({
      operationId: operation.operationId,
      planId: operation.planId,
      status: operationStatus(operation, records, now),
      admissionState: operation.admissionState,
      durability: durabilityOf(operation, records),
      interrupted: operation.interrupted,
    });
  }

  return {
    ok: true,
    result: { limit, operations: summaries },
    human: [
      "syndroo receipts list",
      ...(summaries.length === 0
        ? ["  no local operations"]
        : summaries.map(
            summary =>
              `  ${String(summary["operationId"])} ${String(summary["status"])} ${String(summary["admissionState"])}`,
          )),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/** `syndroo receipts show` — one operation and its authoritative records. */
export async function runReceiptsShow(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  rejectTimeoutFlag(context);

  const operationId = context.parsed.positionals[0];

  if (operationId === undefined) {
    throw usageError("receipts show needs an operation id");
  }

  if (!LOCAL_ID_PATTERN.operationId.test(operationId)) {
    throw localError(
      "INVALID_DOCUMENT",
      "the operation id is not a local operation id",
    );
  }

  const runtime = await openLocalRuntime(context, overrides);
  const namespace = await requireNamespace(context, runtime);
  const operation = await runtime.store.getOperation(operationId);

  if (operation === null) {
    throw usageError("no operation with this id exists in this state");
  }

  if (operation.namespace !== namespace) {
    throw configError("this operation belongs to a different namespace");
  }

  const records = await readDeliveries(runtime.store, operation);
  const now = runtime.clock();
  const status = operationStatus(operation, records, now);

  return {
    ok: true,
    result: {
      operation: {
        operationId: operation.operationId,
        planId: operation.planId,
        status,
        admissionState: operation.admissionState,
        durability: durabilityOf(operation, records),
        interrupted: operation.interrupted,
      },
      results: records.map(record => targetResult(record, now)),
    },
    human: [
      "syndroo receipts show",
      `  operation  ${operation.operationId}`,
      `  status     ${status}`,
      `  admission  ${operation.admissionState}`,
      ...records.map(
        record =>
          `  target     ${record.delivery.target.provider} ${record.delivery.target.targetId} ${record.status} attempts ${record.attempts}`,
      ),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
