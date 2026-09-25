import { createInterface } from "node:readline";

import type { LocalProviderId } from "@syndroo/core";

import { CliError, usageError } from "../../cli-error.js";
import { EXIT_CODE, type ExitCode } from "../../exit-codes.js";
import type { CliIo } from "../../io.js";
import { frozenBusinessTime, previewForPlan } from "../../local/plan.js";
import type { LocalPreviewResult } from "../../local/results.js";
import { localError } from "../../local/errors.js";
import type { LocalPlan } from "../../local/ports/local-store.js";
import type { LocalEnvelopeError } from "../../output.js";
import type { Reporter } from "../../output.js";
import { flagValue, hasFlag, type CommandContext } from "../context.js";

/** What one local command produced. `result` is the envelope's `result`. */
export interface LocalCommandOutcome {
  readonly ok: boolean;
  readonly result: unknown;
  readonly human: readonly string[];
  readonly exitCode: ExitCode;
  /** Required whenever `ok` is false: a safe, documented envelope error. */
  readonly error?: LocalEnvelopeError | undefined;
}

export type LocalHandler = (
  context: CommandContext,
) => Promise<LocalCommandOutcome>;

/** Command budget, fixed by the contract. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** How long one prompt may wait for a human before it counts as a refusal. */
const PROMPT_LIMIT_MS = 10 * 60 * 1_000;

const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["bluesky", "threads"]);

const REMOTE_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "x",
  "tumblr",
  "linkedin",
]);

const TIMEOUT_PATTERN = /^(\d+)(ms|s)?$/u;

/**
 * `--timeout` for a local command.
 *
 * The message is static: a user-supplied duration is never repeated back.
 */
export function parseLocalTimeoutMs(context: CommandContext): number {
  const raw = flagValue(context, "timeout");

  if (raw === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }

  const match = TIMEOUT_PATTERN.exec(raw.trim());

  if (match === null) {
    throw usageError(
      "--timeout must be a positive whole number of seconds or milliseconds, for example 120s or 15000ms",
    );
  }

  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2] === "ms" ? 1 : 1_000;
  const total = amount * unit;

  if (!Number.isSafeInteger(total) || total <= 0) {
    throw usageError("--timeout must be greater than zero");
  }

  if (total > MAX_COMMAND_TIMEOUT_MS) {
    throw usageError("--timeout must not exceed 600s");
  }

  return total;
}

/** `--timeout` is only meaningful for execution or an explicit online verify. */
export function rejectTimeoutFlag(context: CommandContext): void {
  if (flagValue(context, "timeout") !== undefined) {
    throw usageError("--timeout is only accepted for execution or `auth status --verify`");
  }
}

/** `--limit` for `receipts list`: 1-100, default 20. */
export function parseReceiptLimit(context: CommandContext): number {
  const raw = flagValue(context, "limit");

  if (raw === undefined) {
    return 20;
  }

  if (!/^\d+$/u.test(raw.trim())) {
    throw usageError("--limit must be a whole number between 1 and 100");
  }

  const limit = Number.parseInt(raw.trim(), 10);

  if (limit < 1 || limit > 100) {
    throw usageError("--limit must be a whole number between 1 and 100");
  }

  return limit;
}

/** One provider name from a positional argument. */
export function selectLocalProvider(value: string): LocalProviderId {
  if (REMOTE_ONLY_PROVIDERS.has(value)) {
    throw localError(
      "PROVIDER_LOCAL_UNAVAILABLE",
      "this platform has no local publishing path in this version",
    );
  }

  if (!LOCAL_PROVIDERS.has(value)) {
    throw localError(
      "INVALID_DOCUMENT",
      "the provider must be one of the local providers",
    );
  }

  return value as LocalProviderId;
}

/** A comma-separated explicit retry selection: non-empty, unique, local. */
export function parseRetrySelection(value: string): readonly LocalProviderId[] {
  const names = value
    .split(",")
    .map(name => name.trim())
    .filter(name => name.length > 0);

  if (names.length === 0) {
    throw usageError("--to needs at least one local provider");
  }

  const selection: LocalProviderId[] = [];

  for (const name of names) {
    const provider = selectLocalProvider(name);

    if (selection.includes(provider)) {
      throw usageError("--to must not repeat a provider");
    }

    selection.push(provider);
  }

  return selection;
}

function interrupted(): CliError {
  return new CliError("INTERRUPTED: the local process stopped on a signal", {
    code: "INTERRUPTED",
    exitCode: EXIT_CODE.INTERRUPTED,
  });
}

/** True when a human can actually answer a prompt. */
export function interactiveIo(io: CliIo): boolean {
  return (
    io.stdinIsTty &&
    io.stdoutIsTty &&
    typeof io.readTtyLine === "function" &&
    io.hasTty()
  );
}

/**
 * Confirmation for one local write.
 *
 * Non-interactive runs need both `--yes` and `--no-input`; `--yes` alone is
 * only a promise that a human does not have to answer here. A decline is exit
 * 5, a missing confirmation exit 2, and neither happens after a content request
 * because this runs before the plan is executed.
 */
export async function confirmLocalWrite(
  context: CommandContext,
  lines: readonly string[],
): Promise<void> {
  const io = context.io;
  const yes = hasFlag(context, "yes");
  const noInput = hasFlag(context, "no-input");

  if (io.signal.aborted) {
    throw interrupted();
  }

  for (const line of lines) {
    context.reporter.localDiagnostic(line);
  }

  if (!interactiveIo(io) || noInput) {
    if (!yes || !noInput) {
      throw localError(
        "CONFIRMATION_REQUIRED",
        "a non-interactive run needs both --yes and --no-input",
      );
    }

    return;
  }

  if (yes) {
    return;
  }

  if (!(await ask(context))) {
    throw new CliError("CANCELLED: the operator declined this local write", {
      code: "CANCELLED",
      exitCode: EXIT_CODE.CANCELLED,
    });
  }
}

/** An abortable, bounded prompt on stderr. Never reads the document channel. */
async function ask(context: CommandContext): Promise<boolean> {
  const io = context.io;
  const reader = createInterface({
    input: io.stdin,
    output: io.stderr,
    terminal: false,
  });
  let settled = false;

  try {
    context.reporter.localPrompt("Continue? [y/N] ");

    const answer = await new Promise<string | undefined>(resolve => {
      const timer = setTimeout(() => {
        finish(() => resolve(undefined));
      }, PROMPT_LIMIT_MS);
      const onAbort = (): void => {
        finish(() => resolve(undefined));
      };
      const finish = (run: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        io.signal.removeEventListener("abort", onAbort);
        run();
      };

      io.signal.addEventListener("abort", onAbort, { once: true });
      reader.question("", value => finish(() => resolve(value)));
    });

    context.reporter.localDiagnostic("");

    if (io.signal.aborted) {
      throw interrupted();
    }

    return answer !== undefined && /^(y|yes)$/iu.test(answer.trim());
  } finally {
    reader.close();
  }
}

/** Human lines for one frozen preview, including the frozen business time. */
export function previewHumanLines(
  command: string,
  preview: LocalPreviewResult,
  frozenTimes: readonly (string | null)[],
): readonly string[] {
  const lines: string[] = [
    `syndroo ${command}`,
    `  plan      ${preview.planId}`,
    `  expires   ${preview.expiresAt}`,
    `  digest    ${preview.digest}`,
  ];

  preview.items.forEach((item, index) => {
    lines.push(
      `  item      ${item.provider} ${item.targetId} action=${item.action}`,
      `    account  ${item.targetId}`,
      `    binding ${item.binding.connectionId} revision ${item.binding.bindingRevision}`,
      `    previous ${
        item.previousBinding === null
          ? "none"
          : `${item.previousBinding.connectionId} revision ${item.previousBinding.bindingRevision}`
      }`,
    );

    const frozen = frozenTimes[index];

    if (frozen !== null && frozen !== undefined) {
      lines.push(`    frozen  createdAt ${frozen}`);
    }

    // The exact frozen text, one rendered line at a time. Nothing is rewritten
    // or trimmed here: the reporter escapes control characters and leaves the
    // data itself alone.
    for (const line of item.content.split("\n")) {
      lines.push(`    content | ${line}`);
    }
  });

  return lines;
}

export { frozenBusinessTime };

/**
 * A diagnostic that cannot fail the command.
 *
 * Human output is not the work; a closed or failing stream must not re-enter a
 * provider or turn an unfinished run into a clean success. The caller decides
 * what a failed write means for the exit code.
 */
export function safeDiagnostic(
  reporter: Reporter,
  message: string,
): boolean {
  try {
    reporter.localDiagnostic(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * One disposable budget for a whole command.
 *
 * It links the real caller signal (so Ctrl-C still stops the run) with a single
 * deadline that covers the command's own work. `pause`/`resume` exist so a
 * human reading a confirmation does not consume the network budget; the caller
 * signal stays linked while paused.
 */
export interface CommandBudget {
  readonly signal: AbortSignal;
  pause(): void;
  resume(): void;
  dispose(): void;
}

export function commandBudget(
  callerSignal: AbortSignal,
  timeoutMs: number,
): CommandBudget {
  const controller = new AbortController();
  const abortFromCaller = (): void => {
    controller.abort(callerSignal.reason);
  };

  if (callerSignal.aborted) {
    abortFromCaller();
  } else {
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  let remaining = timeoutMs;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    onDeadline,
    remaining,
  );

  function onDeadline(): void {
    controller.abort(new Error("the local command budget expired"));
  }

  return {
    signal: controller.signal,
    pause: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      }
    },
    resume: () => {
      if (timer === undefined) {
        startedAt = Date.now();
        timer = setTimeout(onDeadline, remaining);
      }
    },
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      callerSignal.removeEventListener("abort", abortFromCaller);
    },
  };
}

/**
 * One frozen plan, reported the way a preview must be reported.
 *
 * The frozen business timestamp goes to stderr as a diagnostic in every mode,
 * including `--json`, because the strict JSON result schema has no field for
 * it. A blocked item is explained instead of being hidden.
 */
export function previewOutcome(
  context: CommandContext,
  label: string,
  plan: LocalPlan,
): LocalCommandOutcome {
  const preview = previewForPlan(plan);
  const frozenTimes = plan.items.map(item => frozenBusinessTime(item.delivery));

  plan.items.forEach((item, index) => {
    const frozen = frozenTimes[index];

    if (frozen !== null && frozen !== undefined) {
      context.reporter.localDiagnostic(
        `${label}: ${item.delivery.target.provider} frozen createdAt ${frozen}`,
      );
    }

    if (item.action === "blocked") {
      context.reporter.localDiagnostic(
        `${label}: ${item.delivery.target.provider} is blocked by an existing record; read the receipt and retry explicitly`,
      );
    }
  });

  return {
    ok: true,
    result: preview,
    human: previewHumanLines(label, preview, frozenTimes),
    exitCode: EXIT_CODE.SUCCESS,
  };
}
