import { usageError } from "../../cli-error.js";
import {
  openLocalRuntime,
  requireNamespace,
  type LocalRunOverrides,
} from "../../local/composition.js";
import { decodeLocalSource, parseLocalPublishDocument } from "../../local/document.js";
import {
  buildLocalPublishIntent,
  frozenBusinessTime,
  previewForPlan,
} from "../../local/plan.js";
import { readLocalInputBytes } from "../../local/source.js";
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

export async function runPublish(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  const input = flagValue(context, "input");
  const data = flagValue(context, "data");
  const dryRun = hasFlag(context, "dry-run");

  if ((input === undefined) === (data === undefined)) {
    throw usageError("publish needs exactly one of --data <json> or --input <path|->");
  }

  if (dryRun) {
    rejectTimeoutFlag(context);
  }

  const timeoutMs = parseLocalTimeoutMs(context);
  const text = data ?? decodeLocalSource(
    await readLocalInputBytes(input as string, context.io),
  ).text;
  const document = parseLocalPublishDocument(text);
  const runtime = await openLocalRuntime(context, overrides);
  const namespace = await requireNamespace(context, runtime);
  const intent = await buildLocalPublishIntent(document, {
    store: runtime.store,
    providers: runtime.providers,
    namespace,
    now: runtime.clock,
  });

  if (dryRun) {
    return previewOutcome(context, "publish --dry-run", intent);
  }

  await confirmLocalWrite(
    context,
    previewHumanLines(
      "publish",
      previewForPlan(intent),
      intent.items.map(item => frozenBusinessTime(item.delivery)),
    ),
  );

  return executeFrozenPlan(context, runtime, intent, timeoutMs);
}
