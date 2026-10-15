/**
 * The shared publication view.
 *
 * `publish` and `status --operation` both need the same answer to "what was
 * sent, to which account and what happened", so both normalize a projected
 * result into this one UI-only shape. It is deliberately not the wire protocol:
 * it holds resolved display identity, preview content and outcome facts, and it
 * never carries a credential, an approval token or a raw internal id besides the
 * ones the renderer is allowed to show.
 *
 * Identity resolution happens over the whole target set, so two different
 * targets can never render as the same string: the readable name and label are
 * preferred, a shortened `accountId` is the fallback, and a collision expands
 * the id or qualifies it with the verified origin. Nothing here changes target
 * selection, account de-duplication or binding — the stable identity stays
 * `provider + origin + accountId`.
 */

import type {
  DeliveryResult,
  DryRunResult,
  ExecutionResult,
  ExecutionStatus,
  NotStarted,
  OperationView,
  PreparedResult,
  ProviderWriteOutcome,
  TargetPreview,
} from "@syndroo/core";
import { safePublicUrl } from "@syndroo/provider-sdk";

import { graphemes } from "./terminal-text.js";

export type PublicationMode = "preview" | "live" | "recorded";
export type PublicationPhase = "prepared" | "execution" | "dry_run" | "failure";
export type PublicationOutcome = ProviderWriteOutcome | NotStarted | null;
export type PublicationInput = PreparedResult | ExecutionResult | OperationView | DryRunResult;

export type PublicationTargetView = {
  readonly deliveryId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly accountId: string;
  readonly origin: string;
  /** Final, unambiguous display identity for this target set. */
  readonly displayName: string;
  /** The public profile URL, or the verified origin when there is none. */
  readonly displayUrl: string;
  readonly preview?: { readonly content: { readonly text?: string }; readonly fields: readonly { readonly name: string; readonly value: unknown }[] };
  readonly state?: "ready" | "in_flight" | "settled";
  readonly outcome?: PublicationOutcome;
  readonly attempts?: number;
};

export type PublicationView = {
  readonly mode: PublicationMode;
  readonly phase: PublicationPhase;
  readonly operationId?: string;
  readonly status?: ExecutionStatus;
  readonly confirmation?: "required" | "expired";
  readonly expiresAt?: string;
  readonly targets: readonly PublicationTargetView[];
  readonly unverified: readonly string[];
  readonly durabilityWarning?: "OUTCOME_NOT_DURABLE";
  readonly failureCode?: string;
};

/** Contract limits from the design: identity fallback and its expansion. */
const ID_PREFIX = 12;
const ID_SUFFIX = 4;

/** One target before display disambiguation. */
type Draft = {
  readonly deliveryId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly accountId: string;
  readonly origin: string;
  readonly identity?: string;
  readonly preview?: PublicationTargetView["preview"];
  readonly state?: "ready" | "in_flight" | "settled";
  readonly outcome?: PublicationOutcome;
  readonly attempts?: number;
  /** Graphemes of `accountId`, segmented once so escalation stays cheap. */
  readonly clusters: readonly string[];
  /** The whole escalation ladder, built once and reused across rounds. */
  ladder?: readonly string[];
  displayUrl: string;
  displayName: string;
  step: number;
};

/** `first…last` over an already segmented id, or the id when it is short. */
function abbreviateClusters(clusters: readonly string[], prefix: number): string {
  if (clusters.length <= prefix + ID_SUFFIX) {
    return clusters.join("");
  }

  return `${clusters.slice(0, prefix).join("")}…${clusters.slice(-ID_SUFFIX).join("")}`;
}

/**
 * Shorten an id to `first…last` inside the shared limits, or return it whole
 * when it is short enough that shortening would not help.
 */
export function abbreviateId(value: string, prefix = ID_PREFIX): string {
  return abbreviateClusters(graphemes(value), prefix);
}

/** `name (label)`, collapsing the parenthesis when both are the same text. */
function identityOf(presentation:
  | { readonly accountName?: string; readonly profileUrl?: string; readonly label?: string }
  | undefined): string | undefined {
  const name = presentation?.accountName;
  const label = presentation?.label;

  if (name !== undefined && label !== undefined) {
    return name === label ? name : `${name} (${label})`;
  }

  return name ?? label;
}

/**
 * Every progressively more specific form of one target's display, in order.
 *
 * Stage 0 is the default; each later stage discloses more of the account id,
 * then the verified origin, then the connection id, until the whole target set
 * is unambiguous. The last entry repeats so an escalation never runs off the
 * end.
 */
function stages(draft: Draft): readonly string[] {
  const forms: string[] = [];
  const lastPrefix = Math.max(ID_PREFIX, draft.clusters.length);

  for (let prefix = ID_PREFIX; prefix <= lastPrefix; prefix += 1) {
    const form = abbreviateClusters(draft.clusters, prefix);

    if (forms.at(-1) !== form) {
      forms.push(form);
    }
  }

  const wrap = (inner: string): string =>
    draft.identity === undefined ? inner : `${draft.identity} (${inner})`;
  const qualified = `${draft.accountId} @ ${draft.origin}`;

  // The readable identity is stage 0 when there is one; without it the first
  // abbreviated id already is the default, so it must not repeat.
  return [
    ...(draft.identity === undefined ? [] : [draft.identity]),
    ...forms.map(wrap),
    wrap(qualified),
    `${wrap(qualified)} [${draft.connectionId}]`,
    `${wrap(qualified)} [${draft.connectionId} ${draft.deliveryId}]`,
  ];
}

/**
 * Give every draft a display string that is unique within this target set.
 *
 * Every ladder is built once and reused, so escalation costs one pass per
 * round instead of a rebuilt ladder per draft. Colliding drafts advance one
 * stage per round; the ladder ends with the full account id, the verified
 * origin, the connection id and finally the delivery id, so the loop
 * terminates on a genuinely unique string for any real target set, however
 * long the ids are. Only two byte-identical deliveries would finish on the same
 * string, and rendering them identically is then correct.
 */
function resolveDisplay(drafts: readonly Draft[]): void {
  const counts = new Map<string, number>();

  for (const draft of drafts) {
    draft.ladder = stages(draft);
    draft.step = 0;
    draft.displayName = draft.ladder[0] as string;
  }

  for (;;) {
    counts.clear();

    for (const draft of drafts) {
      counts.set(draft.displayName, (counts.get(draft.displayName) ?? 0) + 1);
    }

    const colliding = drafts.filter((draft) => (counts.get(draft.displayName) ?? 0) > 1);

    if (colliding.length === 0) {
      return;
    }

    let changed = false;

    for (const draft of colliding) {
      const ladder = draft.ladder as readonly string[];

      if (draft.step + 1 < ladder.length) {
        draft.step += 1;
        draft.displayName = ladder[draft.step] as string;
        changed = true;
      }
    }

    if (!changed) {
      // Every colliding draft already shows its full unique form: the last
      // resort is the only string left and it is already displayed.
      return;
    }
  }
}

function draftOf(target: {
  readonly deliveryId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly accountId: string;
  readonly origin: string;
  readonly presentation?: { readonly accountName?: string; readonly profileUrl?: string; readonly label?: string };
  readonly preview?: PublicationTargetView["preview"];
  readonly state?: "ready" | "in_flight" | "settled";
  readonly outcome?: PublicationOutcome;
  readonly attempts?: number;
}): Draft {
  const identity = identityOf(target.presentation);

  return {
    deliveryId: target.deliveryId,
    connectionId: target.connectionId,
    provider: target.provider,
    accountId: target.accountId,
    origin: target.origin,
    ...(identity === undefined ? {} : { identity }),
    ...(target.preview === undefined ? {} : { preview: target.preview }),
    ...(target.state === undefined ? {} : { state: target.state }),
    ...(target.outcome === undefined ? {} : { outcome: target.outcome }),
    ...(target.attempts === undefined ? {} : { attempts: target.attempts }),
    clusters: graphemes(target.accountId),
    displayName: identity ?? abbreviateId(target.accountId),
    displayUrl: safePublicUrl(target.presentation?.profileUrl) ?? target.origin,
    step: 0,
  };
}

function finalize(drafts: readonly Draft[]): readonly PublicationTargetView[] {
  resolveDisplay(drafts);

  return drafts.map((draft) => ({
    deliveryId: draft.deliveryId,
    connectionId: draft.connectionId,
    provider: draft.provider,
    accountId: draft.accountId,
    origin: draft.origin,
    displayName: draft.displayName,
    displayUrl: draft.displayUrl,
    ...(draft.preview === undefined ? {} : { preview: draft.preview }),
    ...(draft.state === undefined ? {} : { state: draft.state }),
    ...(draft.outcome === undefined ? {} : { outcome: draft.outcome }),
    ...(draft.attempts === undefined ? {} : { attempts: draft.attempts }),
  }));
}

function fromPreview(target: TargetPreview): Draft {
  return draftOf({
    deliveryId: target.deliveryId,
    connectionId: target.connectionId,
    provider: target.account.provider,
    accountId: target.account.accountId,
    origin: target.account.origin,
    ...(target.presentation === undefined ? {} : { presentation: target.presentation }),
    preview: target.preview,
  });
}

function fromDelivery(delivery: DeliveryResult): Draft {
  return draftOf({
    deliveryId: delivery.deliveryId,
    connectionId: delivery.connectionId,
    provider: delivery.account.provider,
    accountId: delivery.account.accountId,
    origin: delivery.account.origin,
    ...(delivery.presentation === undefined ? {} : { presentation: delivery.presentation }),
    ...(delivery.preview === undefined ? {} : { preview: delivery.preview }),
    ...(delivery.state === undefined ? {} : { state: delivery.state }),
    outcome: delivery.outcome,
    attempts: delivery.attempts,
  });
}

function isDryRun(input: PublicationInput): input is DryRunResult {
  return "status" in input && input.status === "preview";
}

function isExecution(input: PublicationInput): input is ExecutionResult {
  return "phase" in input && input.phase === "execution";
}

function isOperationPrepared(input: PublicationInput): input is Extract<OperationView, { phase: "prepared" }> {
  return "phase" in input && input.phase === "prepared";
}

/** Normalize one projected result for either reader. */
export function publicationView(input: PublicationInput, mode: PublicationMode): PublicationView {
  if (isDryRun(input)) {
    return {
      mode,
      phase: "dry_run",
      targets: finalize(input.preview.map(fromPreview)),
      unverified: [...input.unverified],
    };
  }

  if (isExecution(input)) {
    return {
      mode,
      phase: "execution",
      operationId: input.operationId,
      status: input.status,
      targets: finalize(input.deliveries.map(fromDelivery)),
      unverified: [],
      ...(input.durabilityWarning === undefined
        ? {}
        : { durabilityWarning: input.durabilityWarning }),
    };
  }

  const prepared = isOperationPrepared(input)
    ? { operationId: input.operationId, confirmation: input.confirmation, expiresAt: input.expiresAt, preview: input.preview }
    : {
        operationId: (input as PreparedResult).operationId,
        confirmation: "required" as const,
        expiresAt: (input as PreparedResult).expiresAt,
        preview: (input as PreparedResult).preview,
      };

  return {
    mode,
    phase: "prepared",
    operationId: prepared.operationId,
    confirmation: prepared.confirmation,
    expiresAt: prepared.expiresAt,
    targets: finalize(prepared.preview.map(fromPreview)),
    unverified: [],
  };
}

/**
 * A preparation that failed before any target existed.
 *
 * There is no per-target outcome to show and, without a real operation id, no
 * query command to offer; the caller supplies the already-classified code.
 */
export function publicationFailureView(input: {
  readonly code: string;
  readonly operationId?: string;
  readonly mode?: PublicationMode;
}): PublicationView {
  return {
    mode: input.mode ?? "live",
    phase: "failure",
    failureCode: input.code,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    targets: [],
    unverified: [],
  };
}
