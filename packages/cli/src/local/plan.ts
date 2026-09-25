import { createHash, randomBytes } from "node:crypto";

import type {
  FrozenDelivery,
  LocalProvider,
  LocalProviderId,
  TargetBinding,
} from "@syndroo/core";

import { configError, usageError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  canonicalDeliveryPayload,
  canonicalJson,
  type LocalPublishDocument,
} from "./document.js";
import { localError } from "./errors.js";
import {
  LOCAL_ID_PATTERN,
  type DeliveryRecord,
  type LocalPlan,
  type LocalStore,
  type PlanItem,
  type PlanKind,
} from "./ports/local-store.js";
import type { LocalPreviewResult } from "./results.js";

/**
 * Offline frozen publish plans.
 *
 * A preview freezes the exact content, payload and target binding, signs the
 * plan under the installation key, and stores it. Nothing here touches the
 * network, a credential source, or a provider session: `provider.freeze` is the
 * only provider call, and it is pure capability validation.
 *
 * Every write assumes the caller already holds the global write lock.
 */

/** Plan lifetime, fixed by the contract. */
const PLAN_TTL_MS = 24 * 60 * 60 * 1_000;

/** Namespace shape frozen with the state schema. */
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Signed plan content: everything except the digest and the MAC. */
export type LocalPlanBody = Omit<LocalPlan, "digest" | "mac">;

export interface PlanLocalPublishOptions {
  readonly store: LocalStore;
  readonly providers: Readonly<Record<LocalProviderId, LocalProvider>>;
  readonly namespace: string;
  readonly now?: () => Date;
}

export interface LoadLocalPlanOptions {
  readonly store: LocalStore;
  readonly kind: PlanKind;
  readonly now?: () => Date;
}

/**
 * Digest and MAC for one plan body.
 *
 * The MAC domain is part of the frozen state contract, so retry plans and the
 * store verify exactly these bytes.
 */
export async function signLocalPlan(
  body: LocalPlanBody,
  store: LocalStore,
): Promise<{ digest: string; mac: string }> {
  const bytes = canonicalJson(body);

  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    mac: await store.authenticate(`plan:v1:${bytes}`),
  };
}

/**
 * Freezes one publish preview and persists it.
 *
 * The plan is written before any content request can happen; a plan with a
 * `blocked` item is still saved, so the operator can see why and use the
 * original receipt or an explicit retry instead.
 */
export async function planLocalPublish(
  document: LocalPublishDocument,
  options: PlanLocalPublishOptions,
): Promise<LocalPlan> {
  const { store, providers, namespace } = options;
  const now = options.now ?? (() => new Date());

  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw configError("the configured namespace is not usable");
  }

  const installation = await store.getInstallation();
  const createdAt = canonicalIso(now());
  const expiresAt = new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString();
  const items: PlanItem[] = [];

  for (const providerId of document.platforms) {
    const provider = providers[providerId] as LocalProvider | undefined;

    if (provider === undefined) {
      throw localError(
        "PROVIDER_LOCAL_UNAVAILABLE",
        "this provider is not available in this build",
      );
    }

    const connection = await store.getConnection(providerId);

    if (connection === null || connection.removed) {
      throw localError(
        "AUTH_SOURCE_UNAVAILABLE",
        "this provider has no active local account binding",
      );
    }

    const target = connection.target;
    const content = finalContent(document, providerId);
    const frozen = provider.freeze(content, createdAt);
    const delivery = canonicalDeliveryPayload(document, target, {
      namespace,
      payloadVersion: frozen.payloadVersion,
      payload: frozen.payload,
    });

    if (delivery.content !== content) {
      throw localError(
        "STATE_CORRUPT",
        "the frozen content and the frozen payload disagree",
      );
    }

    const existing = await store.getDelivery(delivery.deliveryId);

    if (existing === null) {
      items.push({ delivery, action: "publish", previousBinding: null });
      continue;
    }

    assertSameLogicalDelivery(document, namespace, providerId, target, existing);

    const reusable = reusableExisting(
      provider,
      document,
      target,
      namespace,
      existing,
      content,
      createdAt,
    );

    items.push({
      // The plan carries the current active binding; the content, payload and
      // payload hash stay exactly as the authoritative record froze them.
      delivery: {
        deliveryId: delivery.deliveryId,
        key: document.key,
        namespace,
        target,
        content: existing.delivery.content,
        payloadVersion: existing.delivery.payloadVersion,
        payloadHash: existing.delivery.payloadHash,
        payload: existing.delivery.payload,
      },
      action: reusable ? "skip" : "blocked",
      previousBinding: null,
    });
  }

  const body: LocalPlanBody = {
    schemaVersion: 1,
    installationId: installation.installationId,
    planId: `plan_${randomBytes(16).toString("hex")}`,
    kind: "publish",
    namespace,
    createdAt,
    expiresAt,
    items,
    parentOperationId: null,
  };
  const { digest, mac } = await signLocalPlan(body, store);
  const plan: LocalPlan = { ...body, digest, mac };

  await store.putPlan(plan);

  return plan;
}

/**
 * Reads one frozen plan back.
 *
 * The store owns schema, digest, MAC and installation checks; this adds the
 * command shape (`kind`), the id shape, and the expiry rule. A plan whose
 * operation is already admitted is returned even after expiry, so a replay
 * reports the original operation instead of publishing again.
 */
export async function loadLocalPlan(
  planId: string,
  options: LoadLocalPlanOptions,
): Promise<LocalPlan> {
  const { store, kind } = options;
  const now = options.now ?? (() => new Date());

  if (!LOCAL_ID_PATTERN.planId.test(planId)) {
    throw localError("PLAN_TAMPERED", "the plan id is not a local plan id");
  }

  const plan = await store.getPlan(planId);

  if (plan === null) {
    throw usageError("no plan with this id exists in this state");
  }

  if (plan.kind !== kind) {
    throw localError(
      "PLAN_KIND_MISMATCH",
      "the plan was created for a different command",
    );
  }

  const operation = await store.getOperation(
    await store.operationIdFor(plan.planId),
  );

  if (operation !== null && operation.admissionState === "ready") {
    return plan;
  }

  // Canonical ISO timestamps compare lexicographically in time order.
  if (canonicalIso(now()) >= plan.expiresAt) {
    throw localError(
      "PLAN_EXPIRED",
      "the plan expired before it was admitted",
    );
  }

  return plan;
}

/** The result DTO for `publish --dry-run`, exactly as the schema defines it. */
export function previewForPlan(plan: LocalPlan): LocalPreviewResult {
  return {
    planId: plan.planId,
    expiresAt: plan.expiresAt,
    digest: plan.digest,
    items: plan.items.map(item => ({
      key: item.delivery.key,
      provider: item.delivery.target.provider,
      targetId: item.delivery.target.targetId,
      action: item.action,
      content: item.delivery.content,
      binding: {
        connectionId: item.delivery.target.connectionId,
        bindingRevision: item.delivery.target.bindingRevision,
      },
      previousBinding:
        item.previousBinding === null
          ? null
          : {
              connectionId: item.previousBinding.connectionId,
              bindingRevision: item.previousBinding.bindingRevision,
            },
    })),
  };
}

/**
 * The frozen business timestamp a payload carries, when it has one.
 *
 * The JSON preview schema has no field for it, so the human preview reads it
 * from here and shows it next to the content. It is also what a repeated
 * preview reuses, so the same text does not become a conflict only because the
 * clock moved.
 */
export function frozenBusinessTime(delivery: FrozenDelivery): string | null {
  const createdAt = delivery.payload["createdAt"];

  return typeof createdAt === "string" ? createdAt : null;
}

/**
 * Whether an authoritative record can be reported as already delivered.
 *
 * Re-freezing the stored content with the stored business timestamp must
 * reproduce the stored payload version and hash. A provider that changed its
 * payload shape fails this check and blocks the item; the old record is never
 * rewritten.
 */
function reusableExisting(
  provider: LocalProvider,
  document: LocalPublishDocument,
  target: TargetBinding,
  namespace: string,
  existing: DeliveryRecord,
  content: string,
  createdAt: string,
): boolean {
  if (existing.status !== "succeeded" || existing.delivery.content !== content) {
    return false;
  }

  const preserved = provider.freeze(
    existing.delivery.content,
    frozenBusinessTime(existing.delivery) ?? createdAt,
  );
  const recheck = canonicalDeliveryPayload(document, target, {
    namespace,
    payloadVersion: preserved.payloadVersion,
    payload: preserved.payload,
  });

  return (
    preserved.payloadVersion === existing.delivery.payloadVersion &&
    recheck.payloadHash === existing.delivery.payloadHash
  );
}

/** The final content for one provider: its override when selected, else base. */
function finalContent(
  document: LocalPublishDocument,
  provider: LocalProviderId,
): string {
  const override = document.overrides?.[provider];

  return override === undefined ? document.content : override.content;
}

/**
 * A record found by a logical delivery id must describe that same logical
 * delivery. The id is a hash of the tuple, so a mismatch means the stored
 * record is not the one this preview is about.
 */
function assertSameLogicalDelivery(
  document: LocalPublishDocument,
  namespace: string,
  provider: LocalProviderId,
  target: TargetBinding,
  existing: DeliveryRecord,
): void {
  if (
    existing.delivery.key !== document.key ||
    existing.delivery.namespace !== namespace ||
    existing.delivery.target.provider !== provider ||
    existing.delivery.target.targetId !== target.targetId
  ) {
    throw localError(
      "STATE_CORRUPT",
      "a stored delivery record does not match its logical identity",
    );
  }
}

function canonicalIso(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    // A broken clock is a runtime failure, not an admission failure.
    throw localError(
      "LOCAL_RUNTIME_UNSUPPORTED",
      "the local clock is not usable",
      EXIT_CODE.FAILURE,
    );
  }

  return date.toISOString();
}
