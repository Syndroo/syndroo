import { configError, usageError } from "../../cli-error.js";
import {
  explicitNamespace,
  openLocalRuntime,
  requireNamespace,
  type LocalRunOverrides,
} from "../../local/composition.js";
import { loadLocalPlan } from "../../local/plan.js";
import { withLocalWriteLock } from "../../local/state/store.js";
import { flagValue, hasFlag, type CommandContext } from "../context.js";
import { executeFrozenPlan } from "./execute-plan.js";
import {
  confirmLocalWrite,
  parseLocalTimeoutMs,
  parseRetrySelection,
  previewHumanLines,
  previewOutcome,
  rejectTimeoutFlag,
  type LocalCommandOutcome,
} from "./shared.js";

/**
 * `syndroo retry` — explicit, safe, and never automatic.
 *
 * A retry always names its targets. An `unknown` target refuses the whole
 * selection instead of being blindly resent, and `retry --plan` executes one
 * frozen retry plan.
 */
export async function runRetry(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const planId = flagValue(context, "plan");
  const to = flagValue(context, "to");
  const dryRun = hasFlag(context, "dry-run");
  const operationId = context.parsed.positionals[0];

  if (planId !== undefined) {
    if (to !== undefined || dryRun || operationId !== undefined) {
      throw usageError(
        "`retry --plan` takes no operation id, no --to, and no --dry-run",
      );
    }

    return executeRetryPlan(context, planId, overrides);
  }

  if (operationId === undefined || to === undefined || !dryRun) {
    throw usageError(
      "retry needs either `<operation-id> --to <csv> --dry-run` or `--plan <plan-id>`",
    );
  }

  rejectTimeoutFlag(context);

  const selection = parseRetrySelection(to);
  const runtime = await openLocalRuntime(context, overrides);
  const namespace = await requireNamespace(context, runtime);
  const { planLocalRetry } = await import("../../local/retry.js");

  const plan = await withLocalWriteLock(runtime.stateHome, () =>
    planLocalRetry(operationId, selection, {
      store: runtime.store,
      providers: runtime.providers,
      namespace,
      now: runtime.clock,
    }),
  );

  return previewOutcome(context, "retry --dry-run", plan);
}

async function executeRetryPlan(
  context: CommandContext,
  planId: string,
  overrides: LocalRunOverrides,
): Promise<LocalCommandOutcome> {
  const timeoutMs = parseLocalTimeoutMs(context);
  const runtime = await openLocalRuntime(context, overrides);
  const plan = await loadLocalPlan(planId, {
    store: runtime.store,
    kind: "retry",
    now: runtime.clock,
  });

  const explicit = explicitNamespace(context);

  if (explicit !== undefined && explicit !== plan.namespace) {
    throw configError("this plan belongs to a different namespace");
  }

  await confirmLocalWrite(
    context,
    previewHumanLines(
      "retry --plan",
      {
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
      },
      plan.items.map(() => null),
    ),
  );

  return executeFrozenPlan(context, runtime, planId, "retry", timeoutMs);
}
