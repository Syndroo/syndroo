import { usageError } from "../../cli-error.js";
import {
  openLocalRuntime,
  requireNamespace,
  type LocalRunOverrides,
} from "../../local/composition.js";
import { frozenBusinessTime, previewForPlan } from "../../local/plan.js";
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

export async function runRetry(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const to = flagValue(context, "to");
  const operationId = context.parsed.positionals[0];
  const dryRun = hasFlag(context, "dry-run");

  if (operationId === undefined || to === undefined) {
    throw usageError("retry needs <operation-id> and --to <csv>");
  }

  if (dryRun) {
    rejectTimeoutFlag(context);
  }

  const timeoutMs = parseLocalTimeoutMs(context);
  const selection = parseRetrySelection(to);
  const runtime = await openLocalRuntime(context, overrides);
  const namespace = await requireNamespace(context, runtime);
  const { buildLocalRetryIntent } = await import("../../local/retry.js");
  const intent = await buildLocalRetryIntent(operationId, selection, {
    store: runtime.store,
    providers: runtime.providers,
    namespace,
    now: runtime.clock,
  });

  if (dryRun) {
    return previewOutcome(context, "retry --dry-run", intent);
  }

  await confirmLocalWrite(
    context,
    previewHumanLines(
      "retry",
      previewForPlan(intent),
      intent.items.map(item => frozenBusinessTime(item.delivery)),
    ),
  );

  return executeFrozenPlan(context, runtime, intent, timeoutMs);
}
