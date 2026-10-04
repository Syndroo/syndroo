import type { LocalProvider, LocalProviderId } from "@syndroo/core";

import { CliError, usageError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import {
  bindLocalAccount,
  commitLocalObservation,
  commitLocalBinding,
  prepareLocalBindingFromSource,
  removeLocalAccount,
  verifyLocalAccount,
  type LocalBindingResult,
} from "../../local/auth.js";
import {
  type LocalRunOverrides,
  type LocalRuntime,
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

const PROVIDERS: readonly LocalProviderId[] = [
  "bluesky",
  "threads",
  "linkedin",
  "mastodon",
  "devto",
];

/** One registered provider, or an explicit refusal; never an undefined cast. */
function registeredProvider(
  runtime: LocalRuntime,
  provider: LocalProviderId,
): LocalProvider {
  const found = runtime.providers[provider];

  if (found === undefined) {
    throw localError(
      "PROVIDER_LOCAL_UNAVAILABLE",
      "this provider is not available in this build",
    );
  }

  return found;
}

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
  const saveFile = flagValue(context, "save-credential-file");

  let binding: LocalBindingResult;

  try {
    // Verification and confirmation happen with no global write lock; only the
    // optional file save and the revision-checked binding commit take it.
    const { prepared, credentials } = await prepareLocalBindingFromSource(
      source,
      {
        store: runtime.store,
        provider: registeredProvider(runtime, provider),
        env: context.io.env,
        signal: budget.signal,
        expectedTargetId: flagValue(context, "expect-account"),
        clock: runtime.clock,
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
      },
    );

    binding = await withLocalWriteLock(runtime.stateHome, () =>
      commitLocalBinding(prepared, {
        store: runtime.store,
        credentials,
        source,
        ...(saveFile === undefined
          ? {}
          : { saveCredentialFile: { file: saveFile, cwd: context.io.cwd } }),
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
  const unconfiguredProviders: LocalProviderId[] = [];
  const budget =
    timeoutMs === undefined ? undefined : commandBudget(context.io.signal, timeoutMs);

  try {
    for (const provider of selected) {
      const connection = await runtime.store.getConnection(provider);

      if (connection === null || connection.removed) {
        unconfiguredProviders.push(provider);
        continue;
      }

      const binding: Record<string, unknown> = {
        provider,
        targetId: connection.target.targetId,
        connectionId: connection.target.connectionId,
        bindingRevision: connection.target.bindingRevision,
        sourceKind: connection.source.kind,
        configured: true,
        mode: "local",
        displayName: connection.verification?.displayName ?? null,
        lastVerifiedAt: connection.verification?.lastVerifiedAt ?? null,
        verificationSource: connection.verification === undefined ? "unchecked" : "cached",
        readiness: "unchecked",
        nextAction: "verify_identity_and_publish_permissions",
      };

      if (budget !== undefined) {
        try {
          const checked = await verifyLocalAccount(connection, {
            store: runtime.store, provider: registeredProvider(runtime, provider),
            env: context.io.env, signal: budget.signal, clock: runtime.clock,
          });

          // A refresh is committed under a short lock with the same binding
          // revision; it never rewrites history and never claims write access.
          if (checked.observation !== undefined) {
            const observation = checked.observation;

            // Schema 1 keeps the verification result without writing a
            // schema-2 cache: refreshing is never an implicit migration.
            await withLocalWriteLock(runtime.stateHome, () =>
              commitLocalObservation(
                runtime.store,
                provider,
                observation,
                connection.target.bindingRevision,
              ),
            );
          }

          binding["verified"] = checked.verified;
          binding["displayName"] = checked.displayName;
          binding["lastVerifiedAt"] = checked.lastVerifiedAt;
          binding["verificationSource"] = "online";
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          const rejected = error.details?.["readiness"] === "reconnect_required";
          const reconnect = rejected || ["AUTH_SOURCE_CHANGED", "ACCOUNT_MISMATCH"].includes(error.code);
          const missing = error.code === "AUTH_SOURCE_UNAVAILABLE" && !reconnect;
          throw new CliError(error.message, {
            code: error.code, exitCode: error.exitCode,
            details: { provider, readiness: reconnect ? "reconnect_required" : missing ? "missing_credentials" : "unavailable",
              nextAction: reconnect ? "reconnect" : missing ? "configure_credentials" : "retry_identity_verification" },
          });
        }
      }

      bindings.push(binding);
    }
  } finally {
    budget?.dispose();
  }

  return {
    ok: true,
    result: { bindings, unconfiguredProviders },
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
