import { createHash, randomBytes } from "node:crypto";

import {
  LocalProviderError,
  type FrozenDelivery,
  type LocalContentOptions,
  type LocalInstanceObservation,
  type LocalProvider,
  type LocalProviderId,
  type TargetBinding,
} from "@syndroo/core";

import { CliError, configError, usageError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  canonicalDeliveryPayload,
  canonicalJson,
  contentOptionsFor,
  frozenPayloadHash,
  requiresSchema2Record,
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
import type { StateSchemaVersion } from "./ports/local-store.js";

/**
 * Offline publish intents.
 *
 * Building an intent freezes the exact content, payload and target binding and
 * signs it under the installation key. Nothing here touches the network, a
 * credential source or a provider session. It reads state through the store;
 * `provider.freeze` is pure capability validation. Persisting
 * the intent is a separate step so `--dry-run` stays an offline read-only
 * preview.
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
  readonly providers: Readonly<Partial<Record<LocalProviderId, LocalProvider>>>;
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
 * Freezes one publish intent without writing anything.
 *
 * The intent is the immutable execution snapshot: it is persisted before any
 * content request can happen. A `blocked` item is still carried, so the
 * operator can see why and use the original receipt or an explicit retry
 * instead.
 */
export async function buildLocalPublishIntent(
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
    const provider = providers[providerId];

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
    const contentOptions = contentOptionsFor(document, providerId);
    const frozen =
      contentOptions === undefined
        ? provider.freeze(content, createdAt)
        : provider.freeze(content, createdAt, contentOptions);
    const delivery = canonicalDeliveryPayload(document, target, {
      namespace,
      payloadVersion: frozen.payloadVersion,
      payload: frozen.payload,
      ...(contentOptions === undefined ? {} : { contentOptions }),
    });

    if (delivery.content !== content) {
      throw localError(
        "STATE_CORRUPT",
        "the frozen content and the frozen payload disagree",
      );
    }

    const existing = await store.getDelivery(delivery.deliveryId);

    if (existing === null) {
      requireMastodonCapabilities(provider, connection.observation, content);
      items.push({ delivery, action: "publish", previousBinding: null });
      continue;
    }

    assertSameLogicalDelivery(document, namespace, providerId, target, existing);

    const reusable = reusableExisting(
      existing,
      content,
      contentOptions,
      createdAt,
      provider,
    );

    if (!reusable) {
      // The frozen record stays authoritative; an unsent item is blocked until
      // the operator reads the receipt or retries explicitly.
      requireMastodonCapabilities(provider, connection.observation, content);
    }

    items.push({
      // The plan carries the current active binding; the content, payload and
      // payload hash stay exactly as the authoritative record froze them.
      delivery: {
        deliveryId: delivery.deliveryId,
        key: document.key,
        namespace,
        target,
        content: existing.delivery.content,
        ...(existing.delivery.contentOptions === undefined
          ? {}
          : { contentOptions: existing.delivery.contentOptions }),
        payloadVersion: existing.delivery.payloadVersion,
        payloadHash: existing.delivery.payloadHash,
        payload: existing.delivery.payload,
      },
      action: reusable ? "skip" : "blocked",
      previousBinding: null,
    });
  }

  const schemaVersion: StateSchemaVersion = items.some(item =>
    requiresSchema2Record(item.delivery.target.provider, item.delivery.contentOptions),
  )
    ? 2
    : 1;

  if (schemaVersion === 2 && installation.schemaVersion < 2) {
    throw schema2Required();
  }

  const body: LocalPlanBody = {
    schemaVersion,
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

  return { ...body, digest, mac };
}

export async function planLocalPublish(
  document: LocalPublishDocument,
  options: PlanLocalPublishOptions,
): Promise<LocalPlan> {
  const plan = await buildLocalPublishIntent(document, options);

  await options.store.putPlan(plan);

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

/**
 * The public result DTO for one previewed intent.
 *
 * It deliberately carries no plan identity or expiry: the internal execution
 * snapshot is not part of the public surface.
 */
/** Cached capability source/time per provider for a static preview. */
export type LocalCapabilityViews = Readonly<
  Partial<
    Record<
      LocalProviderId,
      { readonly source: string | null; readonly checkedAt: string | null } | null
    >
  >
>;

export interface LocalPreviewOptions {
  /**
   * Cached capability source/time per provider. Absent means "not known",
   * never "verified just now".
   */
  readonly capabilities?: LocalCapabilityViews;
}

export function previewForPlan(
  plan: LocalPlan,
  options: LocalPreviewOptions = {},
): LocalPreviewResult {
  return {
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
      ...previewMetadataFor(item.delivery),
      ...(item.delivery.target.provider === "mastodon"
        ? { capabilities: options.capabilities?.["mastodon"] ?? null }
        : {}),
    })),
  };
}

/**
 * Reads the cached capability source/time a static preview must report.
 *
 * This is a read-only state lookup: it never verifies an identity and never
 * reaches the network.
 */
export async function previewCapabilitiesFor(
  store: LocalStore,
  plan: LocalPlan,
): Promise<LocalCapabilityViews> {
  const capabilities: Record<
    LocalProviderId,
    { readonly source: string | null; readonly checkedAt: string | null } | null
  > = {
    bluesky: null,
    threads: null,
    linkedin: null,
    mastodon: null,
    devto: null,
  };
  const seen = new Set<LocalProviderId>();

  for (const item of plan.items) {
    const provider = item.delivery.target.provider;

    if (provider !== "mastodon" || seen.has(provider)) {
      continue;
    }

    seen.add(provider);

    const connection = await store.getConnection(provider);
    const observation = connection?.observation;

    capabilities[provider] =
      observation === undefined
        ? null
        : {
            source: observation.capabilitySource,
            checkedAt: observation.capabilityCheckedAt,
          };
  }

  return capabilities;
}

/** The public visibility every frozen target in this version publishes with. */
function isPublicProvider(provider: LocalProviderId): boolean {
  return provider === "mastodon" || provider === "devto";
}

/**
 * Article metadata and visibility for one previewed target.
 *
 * Legacy text providers add no field at all, so their preview JSON stays byte
 * compatible with the previous version.
 */
function previewMetadataFor(delivery: FrozenDelivery): {
  readonly visibility?: "public";
  readonly article?: {
    readonly title: string;
    readonly tags: readonly string[];
    readonly canonicalUrl: string | null;
  };
} {
  const provider = delivery.target.provider;
  const article = delivery.contentOptions?.article;

  return {
    ...(isPublicProvider(provider) ? { visibility: "public" as const } : {}),
    ...(article === undefined
      ? {}
      : {
          article: {
            title: article.title,
            tags: article.tags ?? [],
            canonicalUrl: article.canonicalUrl ?? null,
          },
        }),
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
  existing: DeliveryRecord,
  content: string,
  contentOptions: LocalContentOptions | undefined,
  createdAt: string,
  provider: LocalProvider,
): boolean {
  if (existing.status !== "succeeded" || existing.delivery.content !== content) {
    return false;
  }

  // Metadata is part of the approved input: a changed title, tag order or
  // canonical URL is a different delivery, never a silent reuse.
  if (
    canonicalJson(existing.delivery.contentOptions ?? null) !==
    canonicalJson(contentOptions ?? null)
  ) {
    return false;
  }

  const preserved =
    existing.delivery.contentOptions === undefined
      ? provider.freeze(
          existing.delivery.content,
          frozenBusinessTime(existing.delivery) ?? createdAt,
        )
      : provider.freeze(
          existing.delivery.content,
          frozenBusinessTime(existing.delivery) ?? createdAt,
          existing.delivery.contentOptions,
        );

  return (
    preserved.payloadVersion === existing.delivery.payloadVersion &&
    frozenPayloadHash(
      preserved.payloadVersion,
      preserved.payload,
      existing.delivery.contentOptions,
    ) === existing.delivery.payloadHash
  );
}

/**
 * The plan-time gate for a Mastodon target that would actually be sent.
 *
 * A succeeded replay needs nothing; a new or unpublished target needs a cached
 * instance capability snapshot, and the frozen text must fit it. The current
 * limit is re-checked in `prepare`; this is the offline, preview-time check.
 */
function requireMastodonCapabilities(
  provider: LocalProvider,
  observation: LocalInstanceObservation | undefined,
  content: string,
): void {
  if (provider.provider !== "mastodon") {
    return;
  }

  const capabilities = observation?.capabilities ?? null;
  const checkedAt = observation?.capabilityCheckedAt ?? null;

  if (capabilities === null || checkedAt === null) {
    throw localError(
      "PROVIDER_LOCAL_UNAVAILABLE",
      "this instance has no cached capability snapshot; verify the account before previewing",
    );
  }

  const validate = provider.validateCachedContent;

  // The platform-specific algorithm lives in the adapter package. Until it is
  // registered, the cached snapshot is required but the length check itself is
  // the adapter integration hook (A3); nothing here guesses a URL algorithm.
  if (validate === undefined) {
    return;
  }

  try {
    validate.call(provider, content, capabilities);
  } catch (error) {
    if (error instanceof LocalProviderError && error.code === "INVALID_CONTENT") {
      throw localError(
        "INVALID_DOCUMENT",
        "the frozen text exceeds the cached instance limit",
      );
    }

    throw localError(
      "PROVIDER_LOCAL_UNAVAILABLE",
      "the cached instance limit could not be checked",
    );
  }
}

/** A schema-2 plan needs an explicitly upgraded state; nothing migrates here. */
function schema2Required(): CliError {
  return localError(
    "STATE_VERSION_UNSUPPORTED",
    "this plan needs state schema 2; run `syndroo state upgrade --to 2` first",
    EXIT_CODE.FAILURE,
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
