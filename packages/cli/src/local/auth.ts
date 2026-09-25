import { randomBytes } from "node:crypto";

import {
  LocalProviderError,
  type LocalCredentials,
  type LocalProvider,
  type LocalProviderId,
} from "@syndroo/core";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  credentialFingerprint,
  resolveCredentialSource,
} from "./credentials.js";
import { localError } from "./errors.js";
import type { CredentialReference } from "./ports/credentials.js";
import type { ConnectionRecord, LocalStore } from "./ports/local-store.js";

/**
 * Binding one local account.
 *
 * The slot is per provider: the first successful `bind` creates a
 * `connectionId`, every later set or remove keeps it and increments
 * `bindingRevision`. Secrets live only in an in-memory snapshot; the record
 * keeps the reference and the installation-keyed fingerprint.
 */

/** What the operator confirms before a binding changes. Never a secret. */
export interface LocalAuthPreview {
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
}

/** The safe `auth set` / `auth status --verify` result. */
export interface LocalBindingResult extends LocalAuthPreview {
  readonly verified: true;
}

/** The safe `auth remove` result: a tombstone, not a remote revoke. */
export interface LocalRemovalResult {
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly removed: true;
  readonly bindingRevision: number;
}

function cancelled(): CliError {
  return new CliError(
    "CANCELLED: the operator declined the local account change",
    { code: "CANCELLED", exitCode: EXIT_CODE.CANCELLED },
  );
}

/**
 * The caller's signal fired before this layer wrote anything.
 *
 * This is deliberately a runtime failure, not `INTERRUPTED`: the command
 * budget aborts the same signal, and only the CLI composition knows whether the
 * operator actually pressed Ctrl-C. Nothing is written and the caller decides
 * the final code from the original signal.
 */
function aborted(): CliError {
  return new CliError(
    "ABORTED: the local account change was cancelled before it was written",
    { code: "ABORTED", exitCode: EXIT_CODE.FAILURE },
  );
}

/**
 * Maps a provider failure onto a safe, static CLI error.
 *
 * Only the documented local provider codes are allowed through; a raw error
 * (including provider text and any credential) collapses into a static
 * sentence so it can be printed without leaking anything.
 */
function providerFailure(error: unknown): CliError {
  if (error instanceof LocalProviderError) {
    switch (error.code) {
      case "AUTH":
        return localError(
          "AUTH_SOURCE_UNAVAILABLE",
          "the provider rejected the credentials",
        );
      case "ACCOUNT_MISMATCH":
        return localError(
          "ACCOUNT_MISMATCH",
          "the credentials identify a different account",
        );
      case "INVALID_CONTENT":
        return localError(
          "INVALID_DOCUMENT",
          "the provider rejected the frozen content",
        );
      case "PROVIDER_UNAVAILABLE":
        return new CliError(
          "PROVIDER_UNAVAILABLE: the provider is unavailable",
          { code: "PROVIDER_UNAVAILABLE", exitCode: EXIT_CODE.FAILURE },
        );
      case "ABORTED":
        return new CliError("ABORTED: the provider call was aborted", {
          code: "ABORTED",
          exitCode: EXIT_CODE.FAILURE,
        });
    }
  }

  return localError(
    "AUTH_SOURCE_UNAVAILABLE",
    "the provider could not verify the credentials",
  );
}

function newConnectionId(): string {
  return `conn_${randomBytes(16).toString("hex")}`;
}

function assertReferenceMatchesProvider(
  source: CredentialReference,
  provider: LocalProviderId,
): void {
  if (source.provider !== provider) {
    throw localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "the credential source does not belong to this provider",
    );
  }
}

/**
 * Verifies an account and registers it as this provider's active binding.
 *
 * The current revision is read *before* the identity lookup, so a writer that
 * changes the slot during the network call or the confirmation makes the
 * compare-and-set below fail instead of silently overwriting it.
 */
export async function bindLocalAccount(
  source: CredentialReference,
  options: {
    readonly store: LocalStore;
    readonly provider: LocalProvider;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
    readonly expectedTargetId?: string | undefined;
    readonly confirm: (preview: LocalAuthPreview) => Promise<boolean>;
  },
): Promise<LocalBindingResult> {
  const providerId = options.provider.provider;
  assertReferenceMatchesProvider(source, providerId);

  const current = await options.store.getConnection(providerId);
  const credentials = await resolveCredentialSource(source, {
    env: options.env,
  });
  const fingerprint = await credentialFingerprint(credentials, options.store);

  let identity: { targetId: string };

  try {
    identity = await options.provider.verifyIdentity(
      credentials,
      options.signal,
    );
  } catch (error) {
    throw providerFailure(error);
  }

  if (
    options.expectedTargetId !== undefined &&
    options.expectedTargetId !== identity.targetId
  ) {
    throw localError(
      "ACCOUNT_MISMATCH",
      "the credentials identify a different account than the one expected",
    );
  }

  const bindingRevision = (current?.target.bindingRevision ?? 0) + 1;
  const connectionId = current?.target.connectionId ?? newConnectionId();
  const preview: LocalAuthPreview = {
    provider: providerId,
    targetId: identity.targetId,
    connectionId,
    bindingRevision,
  };

  if (!(await options.confirm(preview))) {
    throw cancelled();
  }

  if (options.signal.aborted) {
    throw aborted();
  }

  const record: ConnectionRecord = {
    schemaVersion: 1,
    target: {
      provider: providerId,
      targetId: identity.targetId,
      connectionId,
      bindingRevision,
    },
    source,
    fingerprint,
    removed: false,
  };

  await options.store.putConnection(
    record,
    current === null ? null : current.target.bindingRevision,
  );

  return { ...preview, verified: true };
}

/**
 * Re-checks a binding without changing it.
 *
 * Read-only: the source is resolved once, the fingerprint must still match, and
 * the provider must still report exactly the bound stable target.
 */
export async function verifyLocalAccount(
  connection: ConnectionRecord,
  options: {
    readonly store: LocalStore;
    readonly provider: LocalProvider;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
  },
): Promise<LocalBindingResult> {
  if (connection.removed) {
    throw localError(
      "BINDING_CHANGED",
      "this provider has no active local binding",
    );
  }

  const providerId = options.provider.provider;
  assertReferenceMatchesProvider(connection.source, providerId);

  if (connection.target.provider !== providerId) {
    throw localError(
      "ACCOUNT_MISMATCH",
      "the binding belongs to a different provider",
    );
  }

  const credentials = await resolveCredentialSource(connection.source, {
    env: options.env,
  });
  const fingerprint = await credentialFingerprint(credentials, options.store);

  if (fingerprint !== connection.fingerprint) {
    throw localError(
      "AUTH_SOURCE_CHANGED",
      "the credential source no longer matches the registered binding",
    );
  }

  let identity: { targetId: string };

  try {
    identity = await options.provider.verifyIdentity(
      credentials,
      options.signal,
    );
  } catch (error) {
    throw providerFailure(error);
  }

  if (identity.targetId !== connection.target.targetId) {
    throw localError(
      "ACCOUNT_MISMATCH",
      "the credentials now identify a different account",
    );
  }

  return {
    provider: providerId,
    targetId: connection.target.targetId,
    connectionId: connection.target.connectionId,
    bindingRevision: connection.target.bindingRevision,
    verified: true,
  };
}

/**
 * Writes the tombstone for one provider slot.
 *
 * No source read, no network call, no file deletion, and no claim that a remote
 * token was revoked. The revision still increments, so a plan that froze the
 * previous revision cannot be executed against the removed slot.
 */
export async function removeLocalAccount(
  provider: LocalProviderId,
  options: {
    readonly store: LocalStore;
    readonly signal: AbortSignal;
    readonly expectedTargetId?: string | undefined;
    readonly confirm: (preview: LocalAuthPreview) => Promise<boolean>;
  },
): Promise<LocalRemovalResult> {
  const current = await options.store.getConnection(provider);

  if (current === null || current.removed) {
    throw localError(
      "BINDING_CHANGED",
      "there is no active local binding for this provider",
    );
  }

  if (
    options.expectedTargetId !== undefined &&
    options.expectedTargetId !== current.target.targetId
  ) {
    throw localError(
      "ACCOUNT_MISMATCH",
      "the active binding is a different account than the one expected",
    );
  }

  const bindingRevision = current.target.bindingRevision + 1;
  const preview: LocalAuthPreview = {
    provider,
    targetId: current.target.targetId,
    connectionId: current.target.connectionId,
    bindingRevision,
  };

  if (!(await options.confirm(preview))) {
    throw cancelled();
  }

  if (options.signal.aborted) {
    throw aborted();
  }

  await options.store.putConnection(
    {
      ...current,
      target: { ...current.target, bindingRevision },
      removed: true,
    },
    current.target.bindingRevision,
  );

  return {
    provider,
    targetId: current.target.targetId,
    removed: true,
    bindingRevision,
  };
}

/**
 * Resolves the in-memory snapshot one execution is allowed to use.
 *
 * This is the credential seam for `publish --plan` / `retry --plan`: the caller
 * passes the frozen connection and receives values, never a path, fingerprint,
 * or source descriptor. The result is a snapshot for this run only and must not
 * be serialized into a plan, ledger, receipt, or result.
 */
export async function resolveForExecution(
  connection: ConnectionRecord,
  options: {
    readonly store: LocalStore;
    readonly provider: LocalProviderId;
    readonly env: NodeJS.ProcessEnv;
  },
): Promise<LocalCredentials> {
  if (connection.removed) {
    throw localError(
      "BINDING_CHANGED",
      "this provider has no active local binding",
    );
  }

  assertReferenceMatchesProvider(connection.source, options.provider);

  if (connection.target.provider !== options.provider) {
    throw localError(
      "ACCOUNT_MISMATCH",
      "the binding belongs to a different provider",
    );
  }

  const credentials = await resolveCredentialSource(connection.source, {
    env: options.env,
  });
  const fingerprint = await credentialFingerprint(credentials, options.store);

  if (fingerprint !== connection.fingerprint) {
    throw localError(
      "AUTH_SOURCE_CHANGED",
      "the credential source no longer matches the registered binding",
    );
  }

  return credentials;
}
