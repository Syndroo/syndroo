import { randomBytes } from "node:crypto";

import {
  LocalProviderError,
  isLegacyLocalProvider,
  localDisplayName,
  type LocalIdentity,
  type LocalCredentials,
  type LocalInstanceObservation,
  type LocalProvider,
  type LocalProviderId,
} from "@syndroo/core";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  credentialFingerprint,
  resolveCredentialSource,
} from "./credentials.js";
import { saveCredentialFile } from "./credential-save.js";
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
  readonly displayName: string | null;
  readonly lastVerifiedAt: string;
  /** Present only when this run created a new credential file. */
  readonly credentialFileSaved?: boolean;
}

/** What one verification learned, including a cacheable observation. */
export interface VerifiedLocalAccount extends LocalBindingResult {
  readonly observation?: LocalInstanceObservation;
}

/**
 * Everything a binding needs except where it will read credentials from.
 *
 * Built without the global write lock: the network lookup, the TTY
 * confirmation, and the browser wait all happen before this exists. The source
 * is resolved at commit time because a newly saved file becomes the source.
 */
export interface PreparedLocalBinding {
  readonly provider: LocalProviderId;
  readonly preview: LocalAuthPreview;
  readonly record: Omit<ConnectionRecord, "source">;
  readonly expectedRevision: number | null;
  readonly verification: {
    readonly displayName: string | null;
    readonly lastVerifiedAt: string;
  };
  readonly observation: LocalInstanceObservation | undefined;
}

export interface PreparedLocalBindingWithCredentials {
  readonly prepared: PreparedLocalBinding;
  /** In-memory only; never serialized, printed, or written to state. */
  readonly credentials: LocalCredentials;
}

export interface PrepareLocalBindingOptions {
  readonly store: LocalStore;
  readonly provider: LocalProvider;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly expectedTargetId?: string | undefined;
  readonly confirm: (preview: LocalAuthPreview) => Promise<boolean>;
  readonly clock?: () => Date;
  /**
   * The binding snapshot taken before any wait.
   *
   * A caller that prompts, browses, or reaches the network before preparing
   * must capture this first and pass it; it is never re-read after a wait.
   */
  readonly current?: ConnectionRecord | null | undefined;
  /** Scopes the source reported (for example the OAuth token response). */
  readonly reportedScopes?: readonly string[] | undefined;
}

export interface CommitLocalBindingOptions {
  readonly store: LocalStore;
  readonly credentials: LocalCredentials;
  /** The source this binding reads from when no new file is saved. */
  readonly source?: CredentialReference | undefined;
  /** When set, the group is written to this new file and becomes the source. */
  readonly saveCredentialFile?:
    | { readonly file: string; readonly cwd: string }
    | undefined;
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
        return new CliError("AUTH_SOURCE_UNAVAILABLE: the provider rejected the credentials", {
          code: "AUTH_SOURCE_UNAVAILABLE", exitCode: EXIT_CODE.USAGE,
          details: { readiness: "reconnect_required", nextAction: "reconnect" },
        });
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
 * Verifies an account and builds the binding this run would commit.
 *
 * The current revision is read *before* the identity lookup, so a writer that
 * changes the slot during the network call or the confirmation makes the
 * compare-and-set at commit time fail instead of silently overwriting it. No
 * lock is held here and nothing is written: the caller runs this outside the
 * global write lock and commits separately.
 */
export async function prepareLocalBindingFromSource(
  source: CredentialReference,
  options: PrepareLocalBindingOptions,
): Promise<PreparedLocalBindingWithCredentials> {
  const providerId = options.provider.provider;
  assertReferenceMatchesProvider(source, providerId);

  const credentials = await resolveCredentialSource(source, {
    env: options.env,
  });

  return prepareLocalBindingWithCredentials(credentials, options);
}

/** The same preparation, when the credentials already exist in memory. */
export async function prepareLocalBindingWithCredentials(
  credentials: LocalCredentials,
  options: PrepareLocalBindingOptions,
): Promise<PreparedLocalBindingWithCredentials> {
  const providerId = options.provider.provider;

  if (credentials.provider !== providerId) {
    throw localError(
      "ACCOUNT_MISMATCH",
      "the credential source belongs to a different provider",
    );
  }

  const installation = await options.store.getInstallation();

  // A provider this version adds cannot exist in a schema-1 state; refuse
  // before any network call, confirmation, or file creation. Nothing migrates
  // implicitly.
  if (!isLegacyLocalProvider(providerId) && installation.schemaVersion < 2) {
    throw schema2Required();
  }

  const current =
    options.current === undefined
      ? await options.store.getConnection(providerId)
      : options.current;
  const fingerprint = await credentialFingerprint(credentials, options.store);

  let identity: LocalIdentity;

  try {
    identity = await options.provider.verifyIdentity(
      credentials,
      options.signal,
    );
  } catch (error) {
    throw providerFailure(error);
  }

  const now = (options.clock ?? (() => new Date()))();
  const canaries = secretCanaries(credentials);
  const verification = {
    displayName: safeDisplayName(identity.displayName, canaries),
    lastVerifiedAt: now.toISOString(),
  };

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

  // A schema-1 state stays legacy-compatible: no observation is written and
  // no implicit upgrade happens just because a provider reported capabilities.
  const observation =
    installation.schemaVersion < 2
      ? undefined
      : observationFromIdentity(identity, now, canaries, options.reportedScopes);
  const record: Omit<ConnectionRecord, "source"> = {
    schemaVersion:
      isLegacyLocalProvider(providerId) && observation === undefined ? 1 : 2,
    target: {
      provider: providerId,
      targetId: identity.targetId,
      connectionId,
      bindingRevision,
    },
    fingerprint,
    removed: false,
    verification,
    ...(observation === undefined ? {} : { observation }),
  };

  return {
    credentials,
    prepared: {
      provider: providerId,
      preview,
      record,
      expectedRevision: current === null ? null : current.target.bindingRevision,
      verification,
      observation,
    },
  };
}

/**
 * Commits one prepared binding under the caller's short global write lock.
 *
 * A newly saved credential file is written first; if the compare-and-set then
 * fails, the file stays and the failure reports that partial result without a
 * path, fingerprint, or secret. Nothing here deletes or overwrites the file.
 */
export async function commitLocalBinding(
  prepared: PreparedLocalBinding,
  options: CommitLocalBindingOptions,
): Promise<LocalBindingResult> {
  let source = options.source;
  let saved = false;

  if (options.saveCredentialFile !== undefined) {
    const savedFile = await saveCredentialFile({
      file: options.saveCredentialFile.file,
      cwd: options.saveCredentialFile.cwd,
      credentials: options.credentials,
    });

    source = {
      kind: "file",
      provider: prepared.provider,
      path: savedFile.path,
    };
    saved = true;
  }

  if (source === undefined) {
    throw localError(
      "AUTH_SOURCE_UNAVAILABLE",
      "the credential source is not usable",
    );
  }

  const record: ConnectionRecord = { ...prepared.record, source };

  try {
    await options.store.putConnection(record, prepared.expectedRevision);
  } catch (error) {
    if (!saved) {
      throw error;
    }

    const code = error instanceof CliError ? error.code : "BINDING_CHANGED";
    const exitCode =
      error instanceof CliError ? error.exitCode : EXIT_CODE.USAGE;

    throw new CliError(
      `${code}: the credential file was saved, but the account binding changed before it was written`,
      {
        code,
        exitCode,
        details: {
          credentialFileSaved: true,
          bindingChanged: false,
          nextAction: "retry_binding",
        },
      },
    );
  }

  return {
    ...prepared.preview,
    verified: true,
    ...prepared.verification,
    ...(saved ? { credentialFileSaved: true } : {}),
  };
}

/**
 * Verifies an account and registers it as this provider's active binding.
 *
 * Kept as the single-call form for existing callers; the command surface uses
 * the prepare/commit split so no network or TTY wait holds the write lock.
 */
export async function bindLocalAccount(
  source: CredentialReference,
  options: PrepareLocalBindingOptions,
): Promise<LocalBindingResult> {
  // Snapshot the current binding before the source is read or verified.
  const current =
    options.current === undefined
      ? await options.store.getConnection(options.provider.provider)
      : options.current;
  const { prepared, credentials } = await prepareLocalBindingFromSource(
    source,
    { ...options, current },
  );

  return commitLocalBinding(prepared, {
    store: options.store,
    credentials,
    source,
  });
}

/**
 * A cacheable, non-secret observation from one identity lookup.
 *
 * Only what the provider actually reported is recorded; a provider that
 * reports neither capabilities nor scopes produces no observation at all.
 */
function observationFromIdentity(
  identity: LocalIdentity,
  now: Date,
  canaries: readonly string[],
  reportedScopes?: readonly string[] | undefined,
): LocalInstanceObservation | undefined {
  const scopesValue = identity.scopes ?? reportedScopes;

  if (identity.capabilities === undefined && scopesValue === undefined) {
    return undefined;
  }

  const verifiedAt = now.toISOString();
  const capabilities = identity.capabilities ?? null;
  const scopes = scopesValue === undefined
    ? null
    : sanitizeScopes(scopesValue, canaries);

  return {
    displayName: safeDisplayName(identity.displayName, canaries),
    lastVerifiedAt: verifiedAt,
    scopes,
    capabilities,
    capabilitySource: capabilities === null ? null : "instance",
    capabilityCheckedAt: capabilities === null ? null : verifiedAt,
    writePermission: "unknown",
  };
}

/**
 * Bounded, format-checked scope strings.
 *
 * A remote response is data: anything outside the fixed scope shape is dropped,
 * and a value that carries (or percent-decodes to) a resolved secret is never
 * stored or printed.
 */
export function sanitizeScopes(
  scopes: readonly unknown[],
  canaries: readonly string[],
): readonly string[] {
  const safe: string[] = [];

  for (const scope of scopes) {
    if (typeof scope !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(scope)) {
      continue;
    }

    if (containsCanary(scope, canaries)) {
      continue;
    }

    let decoded = scope;

    try {
      decoded = decodeURIComponent(scope);
    } catch {
      continue;
    }

    if (containsCanary(decoded, canaries)) {
      continue;
    }

    if (!safe.includes(scope)) {
      safe.push(scope);
    }

    if (safe.length >= 64) {
      break;
    }
  }

  return safe;
}

/** A schema-2 state is required for a new provider; nothing migrates here. */
function schema2Required(): CliError {
  return localError(
    "STATE_VERSION_UNSUPPORTED",
    "this provider needs state schema 2; run `syndroo state upgrade --to 2` first",
    EXIT_CODE.FAILURE,
  );
}

/**
 * Every secret value that must never be reflected by a remote response.
 *
 * Short values are skipped: they would match too much unrelated text, and a
 * real token or password is never that short.
 */
export function secretCanaries(
  credentials: LocalCredentials,
): readonly string[] {
  const values =
    credentials.provider === "bluesky"
      ? [credentials.identifier, credentials.password]
      : credentials.provider === "linkedin"
        ? [credentials.accessToken]
        : credentials.provider === "mastodon"
          ? [credentials.accessToken]
          : credentials.provider === "devto"
            ? [credentials.apiKey]
            : [credentials.accessToken];

  return values.filter(value => typeof value === "string" && value.length >= 8);
}

function containsCanary(value: string, canaries: readonly string[]): boolean {
  return canaries.some(canary => value.includes(canary));
}

/**
 * Display text with the terminal-safety check plus the secret filter.
 *
 * A provider that echoes the token into its display name gets `null`, never a
 * token in a receipt, log, or state record.
 */
function safeDisplayName(
  value: unknown,
  canaries: readonly string[],
): string | null {
  const safe = localDisplayName(value) ?? null;

  return safe !== null && containsCanary(safe, canaries) ? null : safe;
}

/**
 * Persists one refreshed observation when the state supports it.
 *
 * On schema 1 the verification result is still returned to the operator, but
 * nothing is written: refreshing a cache is never a reason to migrate state.
 */
export async function commitLocalObservation(
  store: LocalStore,
  provider: LocalProviderId,
  observation: LocalInstanceObservation,
  expectedRevision: number,
): Promise<boolean> {
  const installation = await store.getInstallation();

  if (installation.schemaVersion < 2) {
    return false;
  }

  await store.putObservation(provider, observation, expectedRevision);

  return true;
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
    readonly clock?: () => Date;
  },
): Promise<VerifiedLocalAccount> {
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

  let identity: LocalIdentity;

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

  const now = (options.clock ?? (() => new Date()))();
  const canaries = secretCanaries(credentials);
  const observation = observationFromIdentity(identity, now, canaries);

  return {
    provider: providerId,
    targetId: connection.target.targetId,
    connectionId: connection.target.connectionId,
    bindingRevision: connection.target.bindingRevision,
    verified: true,
    displayName: safeDisplayName(identity.displayName, canaries),
    lastVerifiedAt: now.toISOString(),
    ...(observation === undefined ? {} : { observation }),
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
