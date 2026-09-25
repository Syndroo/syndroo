import { createHash } from "node:crypto";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalCredentials,
  type LocalProvider,
  type LocalProviderId,
  type PreparedTarget,
  type ProviderOutcome,
  type TargetBinding,
} from "@syndroo/core";

import { CliError, configError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import { canonicalJson } from "./document.js";
import { localError } from "./errors.js";
import { frozenBusinessTime, loadLocalPlan } from "./plan.js";
import type {
  ConnectionRecord,
  DeliveryRecord,
  LocalPlan,
  LocalStore,
  OperationRecord,
  PlanItem,
  PlanKind,
} from "./ports/local-store.js";
import {
  aggregateStatus,
  targetResultOf,
  type LocalExecutionResult,
  type LocalTargetResult,
} from "./results.js";

/**
 * Executing one frozen publish or retry plan.
 *
 * This module never reads the source document, never resolves a second
 * credential for a target it already prepared, and never dispatches a target
 * without a durable intent record. The caller (composition) holds the global
 * write lock and has already confirmed the plan with the operator; a plan that
 * was admitted once is replayed from its authoritative records instead of
 * being sent again.
 */

/** Command budget (`04` §2): 120s by default, 600s at most. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** Content attempts one logical delivery may ever use, shared with the store. */
const MAX_ATTEMPTS = 3;

/**
 * Resolves one connection's credential group in memory.
 *
 * The resolver owns the credential source: it rebuilds the group, checks it
 * against the installation-keyed fingerprint, and throws a safe `CliError` when
 * the source is missing or changed. Nothing it returns carries a path, a
 * fingerprint, or a secret reference, and nothing it returns is persisted.
 */
export type CredentialResolver = (
  connection: ConnectionRecord,
) => Promise<LocalCredentials>;

export interface ExecuteLocalPlanOptions {
  readonly store: LocalStore;
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  readonly resolveCredentials: CredentialResolver;
  readonly signal: AbortSignal;
  /** The command that owns this plan; the other kind is refused. */
  readonly kind: PlanKind;
  readonly now?: () => Date;
  /** Command budget in milliseconds. The CLI validates the 1..600000 range. */
  readonly timeoutMs?: number;
}

/**
 * Runs one frozen plan to completion.
 *
 * Order is fixed: read the signed plan, replay an admitted operation instead of
 * sending again, check every binding and frozen payload, resolve each
 * credential source once and prepare each target, admit the operation durably,
 * and only then dispatch targets serially.
 */
export async function executeLocalPlan(
  planId: string,
  options: ExecuteLocalPlanOptions,
): Promise<LocalExecutionResult> {
  const { store, kind } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw configError("the command timeout is not a supported value");
  }

  const plan = await loadLocalPlan(planId, { store, kind, now });
  const operationId = await store.operationIdFor(plan.planId);
  const existing = await store.getOperation(operationId);

  if (existing !== null && existing.admissionState === "ready") {
    // Replay: the authoritative records already answer for every target, so no
    // source is re-read, no credential is resolved, and no content request is
    // made even after the plan expired.
    return replayOperation(plan, existing, store, now);
  }

  const budget = startCommandBudget(options.signal, timeoutMs);

  try {
    return await admitAndDispatch(plan, {
      store,
      providers: options.providers,
      resolveCredentials: options.resolveCredentials,
      now,
      budget,
    });
  } finally {
    budget.dispose();
  }
}

/**
 * Whether two bindings describe the same connection at the same revision.
 *
 * Shared with the retry planner, which must never let a plan follow a
 * replacement account.
 */
export function sameTargetBinding(
  left: TargetBinding,
  right: TargetBinding,
): boolean {
  return (
    left.provider === right.provider &&
    left.targetId === right.targetId &&
    left.connectionId === right.connectionId &&
    left.bindingRevision === right.bindingRevision
  );
}

/**
 * Whether this build would still produce the frozen payload.
 *
 * The content and its business timestamp are what the operator approved; if
 * the provider now derives a different payload version or body for the same
 * input, the frozen plan is stale and must not be sent.
 */
export function assertPayloadMatchesProvider(
  provider: LocalProvider,
  delivery: FrozenDelivery,
  fallbackCreatedAt: string,
): void {
  const createdAt = frozenBusinessTime(delivery) ?? fallbackCreatedAt;
  let frozen: {
    payloadVersion: number;
    payload: Readonly<Record<string, unknown>>;
  };

  try {
    frozen = provider.freeze(delivery.content, createdAt);
  } catch {
    throw localError(
      "INVALID_DOCUMENT",
      "the provider no longer accepts the frozen content",
    );
  }

  if (
    frozen.payloadVersion !== delivery.payloadVersion ||
    payloadHash(frozen.payloadVersion, frozen.payload) !== delivery.payloadHash
  ) {
    throw localError(
      "IDEMPOTENCY_CONFLICT",
      "the frozen payload is not what this provider produces now",
    );
  }
}

interface CommandBudget {
  readonly signal: AbortSignal;
  /** The caller's own signal ended the process (SIGINT/SIGTERM), not a timer. */
  callerAborted(): boolean;
  dispose(): void;
}

/**
 * Links the caller's signal (a real SIGINT/SIGTERM) with the command deadline.
 *
 * The deadline never touches the caller's signal, so an ordinary timeout is
 * never reported as a signal exit. Everything is released in `dispose`.
 */
function startCommandBudget(
  callerSignal: AbortSignal,
  timeoutMs: number,
): CommandBudget {
  const controller = new AbortController();
  const forward = (): void => {
    controller.abort(callerSignal.reason);
  };

  if (callerSignal.aborted) {
    forward();
  } else {
    callerSignal.addEventListener("abort", forward, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new Error("the command budget ended"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    callerAborted: () => callerSignal.aborted,
    dispose: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", forward);
    },
  };
}

interface AdmissionContext {
  readonly store: LocalStore;
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  readonly resolveCredentials: CredentialResolver;
  readonly now: () => Date;
  readonly budget: CommandBudget;
}

async function admitAndDispatch(
  plan: LocalPlan,
  context: AdmissionContext,
): Promise<LocalExecutionResult> {
  const { store, providers, budget } = context;
  const now = context.now;
  const connections = new Map<LocalProviderId, ConnectionRecord>();
  const credentials = new Map<LocalProviderId, LocalCredentials>();
  const prepared = new Map<string, PreparedTarget>();

  // 1. Every binding, including a skipped one, must still be the current one.
  for (const item of plan.items) {
    if (item.action === "blocked") {
      throw localError(
        "INVALID_DOCUMENT",
        "the plan holds a target that needs a new preview",
      );
    }

    const providerId = item.delivery.target.provider;
    const connection = await store.getConnection(providerId);

    if (
      connection === null ||
      connection.removed ||
      !sameTargetBinding(connection.target, item.delivery.target)
    ) {
      throw localError(
        "BINDING_CHANGED",
        "the plan binding is not the current account binding",
      );
    }

    connections.set(providerId, connection);
  }

  // 2. Frozen payloads are validated before any session is created.
  for (const item of plan.items) {
    if (item.action === "skip") {
      continue;
    }

    assertPayloadMatchesProvider(
      providerFor(providers, item.delivery.target.provider),
      item.delivery,
      plan.createdAt,
    );
  }

  // 3. One credential resolution and one prepared session per provider, all
  //    before the operation is admitted or any content request is made. A stop
  //    here refuses the whole run before admission: nothing was sent, no
  //    operation exists, and the next invocation starts from a clean slate.
  for (const item of plan.items) {
    if (item.action === "skip") {
      continue;
    }

    if (budget.signal.aborted) {
      throw preflightStopped(budget);
    }

    const providerId = item.delivery.target.provider;
    const connection = connections.get(providerId);
    const provider = providerFor(providers, providerId);

    if (connection === undefined) {
      throw localError(
        "STATE_CORRUPT",
        "the plan binding was not read from this state",
        EXIT_CODE.FAILURE,
      );
    }

    let resolved = credentials.get(providerId);

    if (resolved === undefined) {
      resolved = await context.resolveCredentials(connection);

      if (resolved.provider !== providerId) {
        throw localError(
          "ACCOUNT_MISMATCH",
          "the credential source belongs to a different provider",
        );
      }

      credentials.set(providerId, resolved);
    }

    try {
      const target = await provider.prepare(
        resolved,
        item.delivery.target,
        budget.signal,
      );

      if (budget.signal.aborted) {
        // A provider that answers after the stop instead of reporting it must
        // not let the run reach admission.
        throw preflightStopped(budget);
      }

      if (!sameTargetBinding(target.target, item.delivery.target)) {
        throw localError(
          "ACCOUNT_MISMATCH",
          "the prepared account is not the frozen account",
        );
      }

      prepared.set(item.delivery.deliveryId, target);
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }

      if (budget.signal.aborted) {
        throw preflightStopped(budget);
      }

      throw prepareFailure(error);
    }
  }

  // 4. Durable admission: the manifest is `ready` before the first POST.
  const operation = await store.reserveOperation(plan);

  if (operation.admissionState !== "ready") {
    throw localError(
      "STATE_BUSY",
      "the operation did not finish admission",
      EXIT_CODE.FAILURE,
    );
  }

  // 5. One authoritative read of every record, while nothing has been
  //    dispatched. A missing or unreadable record here is corruption: it is
  //    never replaced with an invented status that could hide history or
  //    invite a duplicate send.
  const baseline = new Map<string, DeliveryRecord>();

  for (const item of plan.items) {
    const record = await store.getDelivery(item.delivery.deliveryId);

    if (record === null) {
      throw localError(
        "STATE_CORRUPT",
        "the operation is missing a delivery record",
        EXIT_CODE.FAILURE,
      );
    }

    baseline.set(item.delivery.deliveryId, record);
  }

  const results: LocalTargetResult[] = [];
  let durability: "committed" | "failed" = "committed";
  let stopping = false;

  for (const item of plan.items) {
    const delivery = item.delivery;
    const base = baseline.get(delivery.deliveryId);

    if (base === undefined) {
      throw localError(
        "STATE_CORRUPT",
        "the operation is missing a delivery record",
        EXIT_CODE.FAILURE,
      );
    }

    if (item.action === "skip") {
      results.push(resultFromRecord(delivery, base, true, now));
      continue;
    }

    if (stopping || budget.signal.aborted) {
      // Not dispatched in this invocation: the record read right after
      // admission is the honest answer, including a previous failure.
      results.push(resultFromRecord(delivery, base, false, now));
      continue;
    }

    let attempt: number;

    try {
      attempt = await store.beginAttempt(
        operation.operationId,
        delivery.deliveryId,
        delivery.target,
      );
    } catch {
      // The intent write is indeterminate: it may have landed, so this target
      // is never reported as retryable. Nothing was dispatched, and
      // post-admission this is a failure report, never exit 2.
      durability = "failed";
      stopping = true;
      results.push(
        await indeterminateAttemptResult(store, delivery, base, now),
      );
      continue;
    }

    if (budget.signal.aborted) {
      // Durable intent exists but this dispatcher never called the provider, so
      // the write is provably not applied. The attempt is consumed.
      const outcome = abortedOutcome();
      const committed = await commitQuietly(
        store,
        operation.operationId,
        delivery,
        attempt,
        outcome,
      );

      if (!committed) {
        durability = "failed";
      }

      stopping = true;
      results.push(resultFromOutcome(delivery, attempt, outcome, false, now));
      continue;
    }

    const target = prepared.get(delivery.deliveryId);

    if (target === undefined) {
      // Unreachable while every executable item is prepared above; kept so a
      // target is never dispatched without a session.
      durability = "failed";
      stopping = true;
      results.push(
        await indeterminateAttemptResult(store, delivery, base, now),
      );
      continue;
    }

    let outcome: ProviderOutcome;

    try {
      outcome = await target.publish(delivery, budget.signal);
    } catch (error) {
      // Once dispatched, a rejection is never evidence that nothing landed.
      outcome = conservativeUnknown(error);
    }

    const committed = await commitQuietly(
      store,
      operation.operationId,
      delivery,
      attempt,
      outcome,
    );

    if (!committed) {
      // The trusted success (or unknown) stays in this process's result; the
      // record on disk may still say `in_flight`, which a later read reports as
      // unknown.
      durability = "failed";
      stopping = true;
    }

    results.push(resultFromOutcome(delivery, attempt, outcome, false, now));
  }

  const interrupted = budget.callerAborted();

  if (interrupted) {
    try {
      await store.markInterrupted(operation.operationId);
    } catch {
      durability = "failed";
    }
  }

  return {
    operationId: operation.operationId,
    planId: plan.planId,
    status: aggregateStatus(results),
    durability,
    ...(interrupted ? { interrupted: true } : {}),
    results,
  };
}

/**
 * Replays an operation that is already admitted.
 *
 * Nothing here can send: every target comes from its authoritative record, and
 * a durable `in_flight` without a trusted outcome is reported as unknown.
 */
async function replayOperation(
  plan: LocalPlan,
  operation: OperationRecord,
  store: LocalStore,
  now: () => Date,
): Promise<LocalExecutionResult> {
  const results: LocalTargetResult[] = [];

  for (const item of plan.items) {
    const record = await store.getDelivery(item.delivery.deliveryId);

    if (record === null) {
      throw localError(
        "STATE_CORRUPT",
        "the operation is missing a delivery record",
        EXIT_CODE.FAILURE,
      );
    }

    results.push(resultFromRecord(item.delivery, record, true, now));
  }

  return {
    operationId: operation.operationId,
    planId: plan.planId,
    status: aggregateStatus(results),
    durability: "committed",
    results,
  };
}

/**
 * The result for a target whose intent write ended without an answer.
 *
 * Nothing was dispatched, but the record may already say `in_flight`, so the
 * on-disk record is re-read: `in_flight` maps to unknown with retry ineligible.
 * If the record cannot be read at all, the answer is a conservative unknown —
 * never an invented `not_started` that would look safe to resend.
 */
async function indeterminateAttemptResult(
  store: LocalStore,
  delivery: FrozenDelivery,
  base: DeliveryRecord,
  now: () => Date,
): Promise<LocalTargetResult> {
  try {
    const record = await store.getDelivery(delivery.deliveryId);

    if (record !== null) {
      return resultFromRecord(delivery, record, false, now);
    }
  } catch {
    // The record cannot be read; the conservative row below is the answer.
  }

  return indeterminateResult(delivery, base, now);
}

async function commitQuietly(
  store: LocalStore,
  operationId: string,
  delivery: FrozenDelivery,
  attempt: number,
  outcome: ProviderOutcome,
): Promise<boolean> {
  try {
    await store.commitOutcome(
      operationId,
      delivery.deliveryId,
      attempt,
      outcome,
    );

    return true;
  } catch {
    return false;
  }
}

function providerFor(
  providers: Readonly<Record<LocalProviderId, LocalProvider>>,
  providerId: LocalProviderId,
): LocalProvider {
  const provider = providers[providerId];

  if (provider === undefined) {
    throw localError(
      "PROVIDER_LOCAL_UNAVAILABLE",
      "this provider is not available in this build",
    );
  }

  return provider;
}

/**
 * A stop before every target was prepared.
 *
 * No content was requested and no operation was admitted, so this is a
 * pre-admission failure: a real caller signal exits 130, an ordinary command
 * deadline exits 1. Neither may be reported as a blocked run with a durable
 * manifest, because the run never got far enough to own one.
 */
function preflightStopped(budget: CommandBudget): CliError {
  if (budget.callerAborted()) {
    return new CliError(
      "INTERRUPTED: the process was stopped before any content request",
      { code: "INTERRUPTED", exitCode: EXIT_CODE.INTERRUPTED },
    );
  }

  return new CliError(
    "COMMAND_TIMEOUT: the command budget ended before every target was prepared",
    { code: "COMMAND_TIMEOUT", exitCode: EXIT_CODE.FAILURE },
  );
}

/**
 * A safe, static failure for a provider that refused to prepare a session.
 *
 * Preparation sends no content, so every one of these is a pre-admission
 * failure: exit 2, zero content requests.
 */
function prepareFailure(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof LocalProviderError) {
    switch (error.code) {
      case "AUTH":
        return new CliError("AUTH: the provider rejected the stored credentials", {
          code: "AUTH",
          exitCode: EXIT_CODE.USAGE,
          cause: error,
        });
      case "ACCOUNT_MISMATCH":
        return localError(
          "ACCOUNT_MISMATCH",
          "the stored credentials identify a different account",
        );
      case "INVALID_CONTENT":
        return localError(
          "INVALID_DOCUMENT",
          "the provider rejected the frozen content",
        );
      case "PROVIDER_UNAVAILABLE":
      case "ABORTED":
        return localError(
          "PROVIDER_LOCAL_UNAVAILABLE",
          "the provider did not answer while preparing a session",
        );
    }
  }

  return new CliError(
    "PROVIDER_LOCAL_UNAVAILABLE: the provider session could not be prepared",
    {
      code: "PROVIDER_LOCAL_UNAVAILABLE",
      exitCode: EXIT_CODE.USAGE,
      cause: error,
    },
  );
}

/** A rejection after dispatch is reported conservatively, never as success. */
function conservativeUnknown(error: unknown): ProviderOutcome {
  if (error instanceof LocalProviderError && error.code === "ABORTED") {
    return { kind: "unknown", code: "ABORTED", writeDisposition: "unknown" };
  }

  return { kind: "unknown", code: "UNEXPECTED", writeDisposition: "unknown" };
}

/** A durable intent whose dispatcher never ran: provably not applied. */
function abortedOutcome(): ProviderOutcome {
  return {
    kind: "failed",
    code: "ABORTED",
    writeDisposition: "not_applied",
    retryable: true,
    retryNotBefore: null,
  };
}

/**
 * A record that could not be read at all.
 *
 * The attempt count is the last trusted value (a lower bound: the lost write
 * may have incremented it), while the status and the retry advice are the
 * conservative ones, so nothing here can authorize a resend.
 */
function indeterminateResult(
  delivery: FrozenDelivery,
  base: DeliveryRecord,
  now: () => Date,
): LocalTargetResult {
  return targetResultOf({
    provider: delivery.target.provider,
    targetId: delivery.target.targetId,
    status: "unknown",
    reused: false,
    attempts: base.attempts,
    outcome: null,
    now: now(),
  });
}

function resultFromRecord(
  delivery: FrozenDelivery,
  record: DeliveryRecord,
  reused: boolean,
  now: () => Date,
): LocalTargetResult {
  return targetResultOf({
    provider: delivery.target.provider,
    targetId: delivery.target.targetId,
    // In an execution result a durable in-flight record is an unknown write.
    status: record.status === "in_flight" ? "unknown" : record.status,
    reused,
    attempts: record.attempts,
    outcome: record.outcome,
    now: now(),
  });
}

function resultFromOutcome(
  delivery: FrozenDelivery,
  attempt: number,
  outcome: ProviderOutcome,
  reused: boolean,
  now: () => Date,
): LocalTargetResult {
  return targetResultOf({
    provider: delivery.target.provider,
    targetId: delivery.target.targetId,
    status:
      outcome.kind === "succeeded"
        ? "succeeded"
        : outcome.kind === "failed"
          ? "failed"
          : "unknown",
    reused,
    attempts: attempt,
    outcome,
    now: now(),
  });
}

function payloadHash(
  payloadVersion: number,
  payload: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(canonicalJson({ payloadVersion, payload }))
    .digest("hex");
}
