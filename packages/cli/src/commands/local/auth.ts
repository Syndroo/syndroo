import type { LocalProviderId } from "@syndroo/core";

import { usageError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import {
  bindLocalAccount,
  removeLocalAccount,
  verifyLocalAccount,
  type LocalBindingResult,
} from "../../local/auth.js";
import {
  type LocalRunOverrides,
  openLocalRuntime,
} from "../../local/composition.js";
import { configError } from "../../cli-error.js";
import { readLocalConfig } from "../../local/config.js";
import { selectCredentialReference } from "../../local/credentials.js";
import { localError } from "../../local/errors.js";
import { withLocalWriteLock } from "../../local/state/store.js";
import { hasFlag, positional, flagValue, type CommandContext } from "../context.js";
import {
  commandBudget,
  confirmLocalWrite,
  interactiveIo,
  parseLocalTimeoutMs,
  rejectTimeoutFlag,
  selectLocalProvider,
  type LocalCommandOutcome,
} from "./shared.js";

const PROVIDERS: readonly LocalProviderId[] = ["bluesky", "threads"];

function requireLocalFlag(context: CommandContext): void {
  if (!hasFlag(context, "local")) {
    throw usageError("this auth command needs --local to select the local path");
  }
}

/**
 * A non-interactive auth write needs both flags and, additionally, the exact
 * account the operator already verified.
 */
function requireNonInteractiveExpectation(
  context: CommandContext,
  what: string,
): void {
  const nonInteractive = !interactiveIo(context.io) || hasFlag(context, "no-input");

  if (!nonInteractive) {
    return;
  }

  if (!hasFlag(context, "yes") || !hasFlag(context, "no-input")) {
    throw localError(
      "CONFIRMATION_REQUIRED",
      `a non-interactive ${what} needs both --yes and --no-input`,
    );
  }

  if (flagValue(context, "expect-account") === undefined) {
    throw localError(
      "CONFIRMATION_REQUIRED",
      `a non-interactive ${what} also needs --expect-account`,
    );
  }
}

/** `syndroo auth set` — verify an account and register its reference. */
export async function runAuthSet(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  requireLocalFlag(context);
  requireNonInteractiveExpectation(context, "auth set");

  const provider = selectLocalProvider(positional(context, 0));
  const source = selectCredentialReference(provider, {
    fromEnv: hasFlag(context, "from-env"),
    credentialFile: flagValue(context, "credential-file"),
    cwd: context.io.cwd,
  });
  const runtime = await openLocalRuntime(context, overrides);
  const timeoutMs = parseLocalTimeoutMs(context);
  const budget = commandBudget(context.io.signal, timeoutMs);

  let binding: LocalBindingResult;

  try {
    binding = await withLocalWriteLock(runtime.stateHome, () =>
      bindLocalAccount(source, {
        store: runtime.store,
        provider: runtime.providers[provider],
        env: context.io.env,
        signal: budget.signal,
        expectedTargetId: flagValue(context, "expect-account"),
        confirm: async preview => {
          // The human's reading time is not part of the request budget; the real
          // caller signal stays linked while the deadline is paused.
          budget.pause();

          try {
            await confirmLocalWrite(context, [
              `syndroo auth set ${provider}`,
              `  account    ${preview.targetId}`,
              `  connection ${preview.connectionId}`,
              `  revision   ${preview.bindingRevision}`,
            ]);
          } finally {
            budget.resume();
          }

          return true;
        },
      }),
    );
  } finally {
    budget.dispose();
  }

  return {
    ok: true,
    result: binding,
    human: [
      `syndroo auth set ${provider}`,
      `  account    ${binding.targetId}`,
      `  connection ${binding.connectionId}`,
      `  revision   ${binding.bindingRevision}`,
      `  verified   yes`,
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/**
 * `syndroo auth status` — read-only.
 *
 * The default is fully offline; `--verify` adds one identity lookup per selected
 * provider and still changes no binding.
 */
export async function runAuthStatus(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  requireLocalFlag(context);

  const verify = hasFlag(context, "verify");
  const timeoutMs = verify ? parseLocalTimeoutMs(context) : undefined;

  if (!verify) {
    rejectTimeoutFlag(context);
  }

  const config = await readLocalConfig(context.io.env);

  if (config === null) {
    throw configError("no local config exists; run `syndroo init` first");
  }

  const runtime = await openLocalRuntime(context, overrides);
  const requested = context.parsed.positionals[0];
  const selected: readonly LocalProviderId[] =
    requested === undefined ? PROVIDERS : [selectLocalProvider(requested)];
  const bindings: Record<string, unknown>[] = [];
  const budget =
    timeoutMs === undefined ? undefined : commandBudget(context.io.signal, timeoutMs);

  try {
    for (const provider of selected) {
      const connection = await runtime.store.getConnection(provider);

      if (connection === null || connection.removed) {
        continue;
      }

      const binding: Record<string, unknown> = {
        provider,
        targetId: connection.target.targetId,
        connectionId: connection.target.connectionId,
        bindingRevision: connection.target.bindingRevision,
        sourceKind: connection.source.kind,
      };

      if (budget !== undefined) {
        const checked = await verifyLocalAccount(connection, {
          store: runtime.store,
          provider: runtime.providers[provider],
          env: context.io.env,
          signal: budget.signal,
        });

        binding["verified"] = checked.verified;
      }

      bindings.push(binding);
    }
  } finally {
    budget?.dispose();
  }

  return {
    ok: true,
    result: { bindings },
    human: [
      "syndroo auth status",
      ...(bindings.length === 0
        ? ["  no active local bindings"]
        : bindings.map(
            binding =>
              `  ${String(binding["provider"])} ${String(binding["targetId"])} revision ${String(binding["bindingRevision"])}${
                binding["verified"] === undefined ? "" : " verified"
              }`,
          )),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/** `syndroo auth remove` — a tombstone, never a remote token revoke. */
export async function runAuthRemove(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  requireLocalFlag(context);
  requireNonInteractiveExpectation(context, "auth remove");

  const provider = selectLocalProvider(positional(context, 0));
  const runtime = await openLocalRuntime(context, overrides);

  const removal = await withLocalWriteLock(runtime.stateHome, () =>
    removeLocalAccount(provider, {
      store: runtime.store,
      signal: context.io.signal,
      expectedTargetId: flagValue(context, "expect-account"),
      confirm: async preview => {
        await confirmLocalWrite(context, [
          `syndroo auth remove ${provider}`,
          `  account    ${preview.targetId}`,
          `  connection ${preview.connectionId}`,
          `  revision   ${preview.bindingRevision}`,
        ]);

        return true;
      },
    }),
  );

  return {
    ok: true,
    result: removal,
    human: [
      `syndroo auth remove ${provider}`,
      `  account    ${removal.targetId}`,
      `  revision   ${removal.bindingRevision}`,
      "  note       the source file is untouched and no remote token was revoked",
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}
