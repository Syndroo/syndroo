import type { LocalCredentials, LocalProviderId } from "@syndroo/core";

import { CliError, usageError } from "../../cli-error.js";
import { EXIT_CODE } from "../../exit-codes.js";
import { LOCAL_CREDENTIAL_ENV_FIELDS, selectCredentialReference } from "../../local/credentials.js";
import {
  commitLocalBinding,
  prepareLocalBindingFromSource,
  prepareLocalBindingWithCredentials,
  sanitizeScopes,
  secretCanaries,
  type LocalBindingResult,
} from "../../local/auth.js";
import {
  type LocalRunOverrides,
  openLocalRuntime,
} from "../../local/composition.js";
import { localError } from "../../local/errors.js";
import { authorizeMastodon, MastodonOAuthError } from "../../local/mastodon-oauth.js";
import { withLocalWriteLock } from "../../local/state/store.js";
import { flagValue, hasFlag, positional, type CommandContext } from "../context.js";
import {
  commandBudget,
  confirmLocalWrite,
  interactiveIo,
  parseLocalTimeoutMs,
  rejectTimeoutFlag,
  selectLocalProvider,
  type LocalCommandOutcome,
} from "./shared.js";

/**
 * `syndroo connect` — the single guarded local connection entry.
 *
 * Everything that waits (network, browser, TTY) runs with no global write
 * lock; only the optional new credential file and the revision-checked binding
 * commit take the short lock. No source is ever guessed, no `.env` is read, and
 * no environment value selects an endpoint.
 */

type SourceChoice =
  | { readonly kind: "env" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "filePrompt" }
  | { readonly kind: "oauth" }
  | { readonly kind: "hidden" };

export async function runConnect(
  context: CommandContext,
  overrides: LocalRunOverrides = {},
): Promise<LocalCommandOutcome> {
  // Refusals happen before any credential read, network call, or state write.
  if (hasFlag(context, "managed")) {
    throw usageError("connect runs locally; --managed is not supported");
  }

  const provider = selectLocalProvider(positional(context, 0));
  const fromEnv = hasFlag(context, "from-env");
  const file = flagValue(context, "credential-file");
  const oauth = hasFlag(context, "oauth");
  const instance = flagValue(context, "instance");
  const saveFile = flagValue(context, "save-credential-file");

  assertFlagCoherence({ provider, fromEnv, file, oauth, instance, saveFile });

  const runtime = await openLocalRuntime(context, overrides);
  const choice = await chooseSource(context, provider, {
    fromEnv,
    file,
    oauth,
    saveFile,
  });

  // Snapshot the current binding once, before any prompt, credential read,
  // browser wait, or network call. It is the only CAS baseline this run uses.
  const current = await runtime.store.getConnection(provider);

  if (choice.kind === "oauth") {
    rejectTimeoutFlag(context);

    return runOAuthConnect(
      context,
      runtime,
      provider,
      saveFile as string,
      instance as string,
      current,
    );
  }

  // Every binding write is a headless-capable write: non-interactive runs need
  // both confirmations and the exact expected account.
  requireNonInteractiveWrite(context, "connect");

  const timeoutMs = parseLocalTimeoutMs(context);
  const budget = commandBudget(context.io.signal, timeoutMs);

  let binding: LocalBindingResult;

  try {
    const confirm = async (preview: {
      readonly targetId: string;
      readonly connectionId: string;
      readonly bindingRevision: number;
    }): Promise<boolean> => {
      budget.pause();

      try {
        await confirmLocalWrite(context, [
          `syndroo connect ${provider}`,
          `  account    ${preview.targetId}`,
          `  connection ${preview.connectionId}`,
          `  revision   ${preview.bindingRevision}`,
        ]);
      } finally {
        budget.resume();
      }

      return true;
    };
    // These prompts happen after the binding snapshot above.
    const filePath =
      choice.kind === "filePrompt"
        ? promptFilePath(context)
        : choice.kind === "file"
          ? choice.path
          : undefined;
    const hiddenCredentials =
      choice.kind === "hidden"
        ? await promptHiddenCredentials(context, provider)
        : undefined;
    const prepareOptions = {
      store: runtime.store,
      provider: providerFor(runtime, provider),
      env: context.io.env,
      signal: budget.signal,
      expectedTargetId: flagValue(context, "expect-account"),
      clock: runtime.clock,
      confirm,
      current,
    };
    // A hidden entry has no reference until it is saved; it therefore requires
    // --save-credential-file, and the saved file becomes the binding source.
    const source =
      choice.kind === "hidden"
        ? undefined
        : selectCredentialReference(provider, {
            fromEnv: choice.kind === "env",
            ...(filePath === undefined ? {} : { credentialFile: filePath }),
            cwd: context.io.cwd,
          });
    const prepared =
      choice.kind === "hidden"
        ? await prepareLocalBindingWithCredentials(
            hiddenCredentials as LocalCredentials,
            prepareOptions,
          )
        : await prepareLocalBindingFromSource(
            source as NonNullable<typeof source>,
            prepareOptions,
          );

    binding = await withLocalWriteLock(runtime.stateHome, () =>
      commitLocalBinding(prepared.prepared, {
        store: runtime.store,
        credentials: prepared.credentials,
        ...(source === undefined ? {} : { source }),
        ...(saveFile === undefined
          ? {}
          : { saveCredentialFile: { file: saveFile, cwd: context.io.cwd } }),
      }),
    );
  } finally {
    budget.dispose();
  }

  return bindingOutcome(provider, binding);
}

/** Flags are checked before any state read or network call. */
function assertFlagCoherence(options: {
  readonly provider: LocalProviderId;
  readonly fromEnv: boolean;
  readonly file: string | undefined;
  readonly oauth: boolean;
  readonly instance: string | undefined;
  readonly saveFile: string | undefined;
}): void {
  const chosen = [
    options.fromEnv ? "env" : null,
    options.file === undefined ? null : "file",
    options.oauth ? "oauth" : null,
  ].filter((value): value is string => value !== null);

  if (chosen.length > 1) {
    throw usageError(
      "connect accepts exactly one credential source: --from-env, --credential-file, or --oauth",
    );
  }

  if (options.oauth) {
    if (options.provider !== "mastodon") {
      throw usageError("--oauth is only available for mastodon");
    }

    if (options.instance === undefined) {
      throw usageError("--oauth needs --instance <https://host>");
    }

    if (options.saveFile === undefined) {
      throw usageError("--oauth needs --save-credential-file <path>");
    }
  } else if (options.instance !== undefined) {
    throw usageError("--instance is only accepted with --oauth");
  }

  if (options.saveFile !== undefined && options.file !== undefined) {
    throw usageError(
      "--save-credential-file creates a new file; --credential-file is read-only import",
    );
  }
}

/** No source: explain on a terminal, refuse immediately otherwise. */
async function chooseSource(
  context: CommandContext,
  provider: LocalProviderId,
  flags: {
    readonly fromEnv: boolean;
    readonly file: string | undefined;
    readonly oauth: boolean;
    readonly saveFile: string | undefined;
  },
): Promise<SourceChoice> {
  if (flags.oauth) {
    return { kind: "oauth" };
  }

  if (flags.file !== undefined) {
    return { kind: "file", path: flags.file };
  }

  if (flags.fromEnv) {
    return { kind: "env" };
  }

  if (!interactiveIo(context.io) || hasFlag(context, "no-input")) {
    throw usageError(
      `connect needs a credential source: --from-env, --credential-file <path>${
        provider === "mastodon"
          ? ", or --oauth --instance <https://host> --save-credential-file <path>"
          : ""
      }`,
    );
  }

  const choice = await promptSource(context, provider);

  if (choice === "env") {
    return { kind: "env" };
  }

  if (choice === "file") {
    return { kind: "filePrompt" };
  }

  if (choice === "oauth" && provider === "mastodon") {
    throw usageError(
      "choose OAuth with the explicit flags: --oauth --instance <https://host> --save-credential-file <path>",
    );
  }

  if (choice === "hidden") {
    if (flags.saveFile === undefined) {
      throw usageError(
        "hidden entry saves a new file: rerun with --save-credential-file <path>",
      );
    }

    return { kind: "hidden" };
  }

  throw usageError("no credential source was chosen");
}

/** One bounded menu prompt; a non-answer is a refusal, never a guess. */
async function promptSource(
  context: CommandContext,
  provider: LocalProviderId,
): Promise<"env" | "file" | "hidden" | "oauth"> {
  context.reporter.localDiagnostic(
    `syndroo connect ${provider}: choose a credential source`,
  );
  context.reporter.localDiagnostic("  1) environment variables");
  context.reporter.localDiagnostic("  2) an existing credential file");
  context.reporter.localDiagnostic("  3) enter credentials on this terminal");
  if (provider === "mastodon") {
    context.reporter.localDiagnostic("  4) browser authorization (--oauth)");
  }

  const answer = context.io.readTtyLine(120_000)?.trim();

  if (answer === "1") {
    return "env";
  }

  if (answer === "2") {
    return "file";
  }

  if (answer === "4" && provider === "mastodon") {
    return "oauth";
  }

  if (answer === "3") {
    return "hidden";
  }

  throw usageError("no credential source was chosen");
}

/** The path prompt, run after the binding snapshot. */
function promptFilePath(context: CommandContext): string {
  context.reporter.localDiagnostic("credential file path:");
  const value = context.io.readTtyLine(120_000);

  if (value === undefined || value.trim().length === 0) {
    throw usageError("no credential file path was given");
  }

  return value.trim();
}

/**
 * Prompts for one provider's complete group.
 *
 * Secret fields use the hidden seam when the terminal provides one; every
 * value stays in memory, and no value is ever echoed to a diagnostic.
 */
async function promptHiddenCredentials(
  context: CommandContext,
  provider: LocalProviderId,
): Promise<LocalCredentials> {
  const hiddenRead = context.io.readHiddenTtyLine;

  if (typeof hiddenRead !== "function") {
    throw localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "this terminal cannot read hidden input; use --from-env or --credential-file",
    );
  }

  const visible = (label: string): string => {
    context.reporter.localDiagnostic(label);
    const value = context.io.readTtyLine(120_000);

    if (value === undefined || value.trim().length === 0) {
      throw usageError("a required credential value was not provided");
    }

    return value.trim();
  };
  const hidden = async (label: string): Promise<string> => {
    const value = await hiddenRead(120_000, context.io.signal, () =>
      context.reporter.localDiagnostic(label),
    );

    if (value === undefined || value.trim().length === 0) {
      throw usageError("a required credential value was not provided");
    }

    return value;
  };

  switch (provider) {
    case "bluesky":
      return {
        provider: "bluesky",
        identifier: visible("bluesky identifier (handle):"),
        password: await hidden("bluesky app password:"),
        host: "bsky.social",
      };
    case "threads":
      return {
        provider: "threads",
        accessToken: await hidden("threads access token:"),
      };
    case "linkedin":
      return {
        provider: "linkedin",
        accessToken: await hidden("linkedin access token:"),
        author: visible("linkedin author URN:"),
        apiVersion: visible("linkedin API version (YYYYMM):"),
      };
    case "mastodon":
      return {
        provider: "mastodon",
        instance: visible("mastodon instance origin:"),
        accessToken: await hidden("mastodon access token:"),
      };
    case "devto":
      return { provider: "devto", apiKey: await hidden("dev.to API key:") };
  }
}

/** OAuth: register, authorize, verify the real account, then bind. */
async function runOAuthConnect(
  context: CommandContext,
  runtime: Awaited<ReturnType<typeof openLocalRuntime>>,
  provider: LocalProviderId,
  saveFile: string,
  instance: string,
  current: Awaited<ReturnType<Awaited<ReturnType<typeof openLocalRuntime>>["store"]["getConnection"]>>,
): Promise<LocalCommandOutcome> {
  // A new provider needs state schema 2 before any app registration exists.
  const installation = await runtime.store.getInstallation();

  if (installation.schemaVersion < 2) {
    throw localError(
      "STATE_VERSION_UNSUPPORTED",
      "mastodon needs state schema 2; run `syndroo state upgrade --to 2` first",
      EXIT_CODE.FAILURE,
    );
  }

  requireNonInteractiveWrite(context, "connect --oauth");

  let credentials: LocalCredentials;
  let scopes: readonly string[];

  try {
    const result = await authorizeMastodon({
      instance,
      signal: context.io.signal,
      confirmRegistration: async preview => {
        context.reporter.localDiagnostic(
          `syndroo connect mastodon --oauth registers one local app on ${preview.instance}`,
        );
        context.reporter.localDiagnostic(
          `  scopes     ${preview.scopes.join(" ")}`,
        );
        context.reporter.localDiagnostic(
          "  note       this leaves an app registration on the instance; Syndroo never deletes it",
        );

        await confirmLocalWrite(context, [
          "Continue with local browser authorization?",
        ]);

        return true;
      },
    });

    credentials = result.credentials;
    // A remote scope list is data: bounded, format-checked, and filtered for
    // any secret it might reflect before it is printed or cached.
    scopes = sanitizeScopes(result.scopes, secretCanaries(result.credentials));
  } catch (error) {
    throw oauthFailure(error);
  }

  const { prepared } = await prepareLocalBindingWithCredentials(credentials, {
    store: runtime.store,
    provider: providerFor(runtime, provider),
    env: context.io.env,
    signal: context.io.signal,
    expectedTargetId: flagValue(context, "expect-account"),
    clock: runtime.clock,
    current,
    reportedScopes: scopes,
    confirm: async preview => {
      await confirmLocalWrite(context, [
        `syndroo connect mastodon`,
        `  account    ${preview.targetId}`,
        `  connection ${preview.connectionId}`,
        `  revision   ${preview.bindingRevision}`,
        `  scopes     ${scopes.join(" ") || "not reported"}`,
      ]);

      return true;
    },
  });

  const binding = await withLocalWriteLock(runtime.stateHome, () =>
    commitLocalBinding(prepared, {
      store: runtime.store,
      credentials,
      source: { kind: "file", provider, path: saveFile },
      saveCredentialFile: { file: saveFile, cwd: context.io.cwd },
    }),
  );

  return bindingOutcome(provider, binding);
}

function oauthFailure(error: unknown): CliError {
  if (!(error instanceof MastodonOAuthError)) {
    return localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "the local browser authorization did not complete; import a user token with --credential-file instead",
    );
  }

  switch (error.code) {
    case "invalid_instance":
      return usageError("--instance must be an HTTPS origin without a path");
    case "unsupported_instance":
      return localError(
        "LOCAL_OAUTH_UNAVAILABLE",
        "this instance does not support secure local OAuth; import a user token with --credential-file instead",
      );
    case "denied":
      return new CliError("CANCELLED: the operator declined the instance authorization", {
        code: "CANCELLED",
        exitCode: EXIT_CODE.CANCELLED,
      });
    case "timeout":
      return localError(
        "AUTH_SOURCE_UNAVAILABLE",
        "the local browser authorization timed out; import a user token with --credential-file instead",
      );
    case "aborted":
    case "interrupted":
      return new CliError("ABORTED: the local authorization was stopped", {
        code: "ABORTED",
        exitCode: EXIT_CODE.FAILURE,
      });
    default:
      return localError(
        "AUTH_SOURCE_UNAVAILABLE",
        "the local browser authorization did not complete; import a user token with --credential-file instead",
      );
  }
}

function providerFor(
  runtime: Awaited<ReturnType<typeof openLocalRuntime>>,
  provider: LocalProviderId,
) {
  const found = runtime.providers[provider];

  if (found === undefined) {
    throw localError(
      "PROVIDER_LOCAL_UNAVAILABLE",
      "this provider is not available in this build",
    );
  }

  return found;
}

/** A non-interactive write needs both flags and the expected account. */
function requireNonInteractiveWrite(context: CommandContext, what: string): void {
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

function bindingOutcome(
  provider: LocalProviderId,
  binding: LocalBindingResult,
): LocalCommandOutcome {
  return {
    ok: true,
    result: { ...binding, bindingChanged: true },
    human: [
      `syndroo connect ${provider}`,
      `  account    ${binding.targetId}`,
      `  connection ${binding.connectionId}`,
      `  revision   ${binding.bindingRevision}`,
      `  verified   yes`,
      ...(binding.credentialFileSaved === true
        ? ["  saved      a new credential file was created"]
        : []),
    ],
    exitCode: EXIT_CODE.SUCCESS,
  };
}

/** Exposed for the guide-only path: never reads a credential source. */
export function connectEnvHints(provider: LocalProviderId): {
  readonly required: readonly string[];
  readonly optional: readonly string[];
} {
  const fields = LOCAL_CREDENTIAL_ENV_FIELDS[provider];

  return { required: fields.required, optional: fields.optional };
}
