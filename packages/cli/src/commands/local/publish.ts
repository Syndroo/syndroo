import { configError, usageError } from "../../cli-error.js";
import {
  explicitNamespace,
  openLocalRuntime,
  requireNamespace,
  type LocalRunOverrides,
} from "../../local/composition.js";
import {
  decodeLocalSource,
  parseLocalPublishDocument,
} from "../../local/document.js";
import {
  frozenBusinessTime,
  loadLocalPlan,
  planLocalPublish,
  previewForPlan,
} from "../../local/plan.js";
import { readLocalInputBytes } from "../../local/source.js";
import { withLocalWriteLock } from "../../local/state/store.js";
import { flagValue, hasFlag, type CommandContext } from "../context.js";
import { executeFrozenPlan } from "./execute-plan.js";
import {
  confirmLocalWrite,
  parseLocalTimeoutMs,
  previewHumanLines,
  previewOutcome,
  rejectTimeoutFlag,
  type LocalCommandOutcome,
} from "./shared.js";

/**
 * `syndroo publish` — the only publish admission path.
 *
 * Exactly two shapes exist: an offline preview that freezes a plan, and the
 * execution of one already-frozen plan. Nothing here reads the source again
 * once a plan exists.
 */
export async function runPublish(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const input = flagValue(context, "input");
  const planId = flagValue(context, "plan");
  const dryRun = hasFlag(context, "dry-run");

  if (planId !== undefined) {
    if (input !== undefined || dryRun) {
      throw usageError("`publish --plan` takes no --input and no --dry-run");
    }

    return executePublishPlan(context, planId, overrides);
  }

  if (input === undefined || !dryRun) {
    throw usageError(
      "publish needs either `--input <path|-> --dry-run` or `--plan <plan-id>`",
    );
  }

  return previewPublishPlan(context, input, overrides);
}

async function previewPublishPlan(
  context: CommandContext,
  input: string,
  overrides: LocalRunOverrides,
): Promise<LocalCommandOutcome> {
  rejectTimeoutFlag(context);

  const bytes = await readLocalInputBytes(input, context.io);
  const source = decodeLocalSource(bytes);
  const document = parseLocalPublishDocument(source.text);
  const runtime = await openLocalRuntime(context, overrides);
  const namespace = await requireNamespace(context, runtime);

  const plan = await withLocalWriteLock(runtime.stateHome, () =>
    planLocalPublish(document, {
      store: runtime.store,
      providers: runtime.providers,
      namespace,
      now: runtime.clock,
    }),
  );

  return previewOutcome(context, "publish --dry-run", plan);
}

async function executePublishPlan(
  context: CommandContext,
  planId: string,
  overrides: LocalRunOverrides,
): Promise<LocalCommandOutcome> {
  const timeoutMs = parseLocalTimeoutMs(context);
  const runtime = await openLocalRuntime(context, overrides);
  const plan = await loadLocalPlan(planId, {
    store: runtime.store,
    kind: "publish",
    now: runtime.clock,
  });

  // An explicit namespace never silently re-interprets a frozen plan: it must
  // be the namespace the plan was frozen in.
  const explicit = explicitNamespace(context);

  if (explicit !== undefined && explicit !== plan.namespace) {
    throw configError("this plan belongs to a different namespace");
  }

  // The confirmation only permits this frozen plan; execution re-reads and
  // re-checks it under the global lock before any content request.
  await confirmLocalWrite(
    context,
    previewHumanLines(
      "publish --plan",
      previewForPlan(plan),
      plan.items.map(item => frozenBusinessTime(item.delivery)),
    ),
  );

  return executeFrozenPlan(context, runtime, planId, "publish", timeoutMs);
}
