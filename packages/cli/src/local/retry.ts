import { randomBytes } from "node:crypto";

import type {
  LocalProvider,
  LocalProviderId,
} from "@syndroo/core";

import { configError, usageError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import { localError } from "./errors.js";
import { assertPayloadMatchesProvider, sameTargetBinding } from "./execute.js";
import { signLocalPlan, type LocalPlanBody } from "./plan.js";
import {
  LOCAL_ID_PATTERN,
  type DeliveryRecord,
  type LocalPlan,
  type LocalStore,
  type PlanAction,
  type PlanItem,
} from "./ports/local-store.js";

/**
 * Explicit, safe retry previews.
 *
 * A retry starts from the parent operation's authoritative records, never from
 * the original input file: the payload, its hash, and the attempt count are the
 * ones already on disk. Only targets the operator names are considered, and a
 * selection that contains an unknown or unfinished write is refused whole, so a
 * new plan can never launder an uncertain result into a resend.
 *
 * Nothing here resolves a credential, opens a session, or reaches the network;
 * `provider.freeze` is pure capability validation only.
 */

/** Retry plans live as long as publish plans; the window is the same contract. */
const PLAN_TTL_MS = 24 * 60 * 60 * 1_000;

/** Namespace shape frozen with the state schema. */
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Content attempts one logical delivery may ever use, shared with the store. */
const MAX_ATTEMPTS = 3;

const LOCAL_PROVIDERS: readonly LocalProviderId[] = ["bluesky", "threads"];

export interface PlanLocalRetryOptions {
  readonly store: LocalStore;
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  /** Must be the namespace that owns the parent operation. */
  readonly namespace: string;
  readonly now?: () => Date;
}

/**
 * Builds and persists one signed retry plan.
 *
 * Every selected provider must be a target of the parent operation. The result
 * is a frozen `retry` plan whose items reuse the authoritative delivery
 * identities and payloads; `retry --plan` admits it through the same store
 * matrix, so attempt limits and windows are re-checked when it is executed.
 */
export async function planLocalRetry(
  operationId: string,
  selection: readonly LocalProviderId[],
  options: PlanLocalRetryOptions,
): Promise<LocalPlan> {
  const { store, providers, namespace } = options;
  const now = options.now ?? (() => new Date());

  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw configError("the configured namespace is not usable");
  }

  if (!LOCAL_ID_PATTERN.operationId.test(operationId)) {
    throw usageError("the operation id is not a local operation id");
  }

  if (selection.length === 0) {
    throw usageError("retry needs at least one target");
  }

  if (new Set(selection).size !== selection.length) {
    throw usageError("retry targets must not repeat");
  }

  for (const provider of selection) {
    if (!LOCAL_PROVIDERS.includes(provider)) {
      throw usageError("retry targets must name local providers");
    }
  }

  const operation = await store.getOperation(operationId);

  if (operation === null) {
    throw usageError("no operation with this id exists in this state");
  }

  if (operation.admissionState !== "ready") {
    // An operation whose admission never finished has no authoritative set of
    // records to retry from; recovery or a new preview comes first.
    throw localError("STATE_BUSY", "the operation has not finished admission");
  }

  if (operation.namespace !== namespace) {
    throw configError("the configured namespace does not own this operation");
  }

  const parent = await store.getPlan(operation.planId);

  if (parent === null) {
    throw localError(
      "STATE_CORRUPT",
      "the operation names a plan that is missing",
      EXIT_CODE.FAILURE,
    );
  }

  const items: PlanItem[] = [];

  for (const provider of selection) {
    const parentItem = parent.items.find(
      item => item.delivery.target.provider === provider,
    );

    if (parentItem === undefined) {
      throw usageError("this operation has no target for that provider");
    }

    items.push(await retryItem(store, providers, parentItem, parent, now));
  }

  const installation = await store.getInstallation();
  const createdAt = isoTime(now);
  const body: LocalPlanBody = {
    schemaVersion: 1,
    installationId: installation.installationId,
    planId: `plan_${randomBytes(16).toString("hex")}`,
    kind: "retry",
    namespace: operation.namespace,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString(),
    items,
    parentOperationId: operation.operationId,
  };
  const { digest, mac } = await signLocalPlan(body, store);
  const plan: LocalPlan = { ...body, digest, mac };

  await store.putPlan(plan);

  return plan;
}

/**
 * One selected target, from its authoritative record.
 *
 * The payload and its hash never change; only the binding may move, and only
 * between revisions of the same stable account. A change is shown as
 * `previousBinding` so the operator confirms it before anything is sent.
 */
async function retryItem(
  store: LocalStore,
  providers: Readonly<Record<LocalProviderId, LocalProvider>>,
  parentItem: PlanItem,
  parent: LocalPlan,
  now: () => Date,
): Promise<PlanItem> {
  const providerId = parentItem.delivery.target.provider;
  const record = await store.getDelivery(parentItem.delivery.deliveryId);

  if (record === null) {
    throw localError(
      "STATE_CORRUPT",
      "the operation is missing a delivery record",
      EXIT_CODE.FAILURE,
    );
  }

  if (record.delivery.namespace !== parent.namespace) {
    throw localError(
      "STATE_CORRUPT",
      "a delivery record does not belong to the plan namespace",
      EXIT_CODE.FAILURE,
    );
  }

  const connection = await store.getConnection(providerId);

  if (connection === null || connection.removed) {
    throw localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "this provider has no active local account binding",
    );
  }

  if (connection.target.targetId !== record.delivery.target.targetId) {
    throw localError(
      "BINDING_CHANGED",
      "the current account binding is a different account",
    );
  }

  const action = retryAction(record, now);

  if (action === "retry") {
    const provider = providers[providerId];

    if (provider === undefined) {
      throw localError(
        "PROVIDER_LOCAL_UNAVAILABLE",
        "this provider is not available in this build",
      );
    }

    assertPayloadMatchesProvider(provider, record.delivery, parent.createdAt);
  }

  const previousBinding = sameTargetBinding(
    record.delivery.target,
    connection.target,
  )
    ? null
    : record.delivery.target;

  return {
    delivery: { ...record.delivery, target: connection.target },
    action,
    previousBinding,
  };
}

/**
 * Whether one authoritative record may take part in a retry.
 *
 * `skip` is a recorded success and never sends. `retry` is a target that is
 * provably not applied: either it was never started, or it failed with a
 * retryable `not_applied` outcome inside its attempt and time budget. Every
 * other state refuses the whole selection.
 */
function retryAction(record: DeliveryRecord, now: () => Date): PlanAction {
  if (record.status === "succeeded") {
    return "skip";
  }

  if (record.status === "not_started") {
    return "retry";
  }

  if (record.status === "unknown") {
    throw localError(
      "OUTCOME_UNKNOWN",
      "a delivery result is unknown and must not be sent again",
    );
  }

  if (record.status === "in_flight") {
    throw localError("STATE_BUSY", "a delivery is still in flight");
  }

  const outcome = record.outcome;

  if (
    outcome === null ||
    outcome.kind !== "failed" ||
    outcome.writeDisposition !== "not_applied" ||
    !outcome.retryable
  ) {
    throw localError(
      "IDEMPOTENCY_CONFLICT",
      "the recorded failure is not safely retryable",
    );
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw localError(
      "ATTEMPTS_EXHAUSTED",
      "the delivery used every attempt",
    );
  }

  if (
    outcome.retryNotBefore !== null &&
    Date.parse(outcome.retryNotBefore) > now().getTime()
  ) {
    throw localError("RETRY_NOT_READY", "the retry window has not opened");
  }

  return "retry";
}

function isoTime(now: () => Date): string {
  const date = now();

  if (!Number.isFinite(date.getTime())) {
    throw localError(
      "LOCAL_RUNTIME_UNSUPPORTED",
      "the local clock is not usable",
      EXIT_CODE.FAILURE,
    );
  }

  return date.toISOString();
}
