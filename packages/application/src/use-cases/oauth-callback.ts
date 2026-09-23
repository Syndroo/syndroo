/**
 * Portable OAuth callback.
 *
 * The callback is the only place a public, unauthenticated request can cause
 * provider work, so the order is deliberately narrow:
 *
 * 1. Snapshot and bound the callback values synchronously. Rejecting duplicated
 *    query parameters is the HTTP runtime's job, because only the wire decoder
 *    sees the raw query string; this use case receives one already-selected
 *    value per parameter, and that split is documented rather than duplicated.
 * 2. Resolve the immutable driver snapshot (possibly asynchronous).
 * 3. Claim once. Only the winning claimant may decrypt a request secret and
 *    exchange; an unknown, throwing or conflicting claim performs zero provider
 *    calls and never retries the claim.
 * 4. Re-check the claimed operation's immutable identity: platform, state,
 *    phase, canonical callback, configuration binding, OAuth1 request token and
 *    operation expiry.
 * 5. Persist a fixed failure for an explicit operator denial, with zero
 *    exchange.
 * 6. Exchange once with the copied request secret, persist fixed failure codes
 *    for provider and response failures, and never echo provider text.
 * 7. Encode and encrypt the candidate, then save it with a fresh completion time
 *    so a late response cannot be stored past the operation's own expiry.
 *
 * The callback never writes the active credential slot.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import type { StoredAuthOperation } from "../contracts/credentials.js";
import { compareInstants, isIsoInstant, isOpaqueId, type IsoInstant } from "../contracts/primitives.js";
import type { SafeTarget } from "../contracts/status.js";
import type { CredentialCipher } from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import { AuthUseCaseError, authFailure } from "./auth-errors.js";
import { OAUTH_CANDIDATE_VERSION, encodeOAuthCandidate } from "./oauth-candidate.js";
import { OAUTH_REQUEST_SECRET_GENERATION, requireDriverSnapshot } from "./oauth-connect.js";
import {
  preserveDriverFailure,
  safeMissingFields,
  storedErrorCodeFor,
  type OAuthCallbackSnapshot,
  type OAuthDriver,
  type OAuthDriverResolver,
  type OAuthStoredErrorCode,
} from "./oauth-driver.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

export interface OAuthCallbackInput {
  readonly platform: Platform;
  readonly state: string;
  readonly code?: string | null;
  readonly verifier?: string | null;
  readonly requestToken?: string | null;
  /** True when the provider redirected with an explicit denial. */
  readonly denied?: boolean;
}

export interface OAuthCallbackOutcome {
  readonly platform: Platform;
  readonly operationId: string;
  readonly phase: "awaiting_confirmation" | "needs_configuration";
  readonly expiresAt: IsoInstant;
  readonly missingFields: readonly string[];
  readonly target: SafeTarget | null;
}

export interface OAuthCallbackDependencies {
  readonly credentials: CredentialStore;
  readonly getCipher: () => CredentialCipher;
  /** Sync or async: a real configuration fingerprint may use WebCrypto. */
  readonly drivers: OAuthDriverResolver;
  readonly clock: UseCaseClock;
}

const MAX_PARAMETER_LENGTH = 1_024;
const MAX_TARGET_LABEL_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

interface CallbackSnapshot {
  readonly callback: OAuthCallbackSnapshot;
  readonly denied: boolean;
}

export async function completeOAuthCallback(
  input: OAuthCallbackInput,
  dependencies: OAuthCallbackDependencies,
): Promise<OAuthCallbackOutcome> {
  const snapshot = snapshotCallback(input);
  const driver = await resolveCallbackDriver(snapshot.callback.platform, dependencies);
  requireProtocolInputs(snapshot.callback, snapshot.denied, driver.protocol);
  const claimTime = readClockNow(dependencies.clock);

  const operation = await claimOnce(snapshot.callback, driver, claimTime, dependencies);
  const settledTime = readClockNow(dependencies.clock);

  // The store already compares these in the winning claim; a mismatch here means
  // the record moved under us, so nothing is exchanged.
  const identityFailure = operationIdentityFailure(operation, snapshot.callback, driver, settledTime);
  if (identityFailure !== null) {
    await persistFailure(operation, identityFailure.errorCode, dependencies);
    throw identityFailure.error;
  }

  if (snapshot.denied) {
    // A browser denial proves the state was ours, so it is persisted as a fixed
    // failure; the driver is never asked to exchange anything.
    await persistFailure(operation, "PROVIDER_DENIED", dependencies);
    throw new AuthUseCaseError("PROVIDER_ERROR", "provider_error");
  }

  let cipher: CredentialCipher;
  try {
    cipher = requireUsableCipher(dependencies);
  } catch (error) {
    // The claim already moved the operation, so the failure is recorded before
    // the fixed readiness error is reported.
    await persistFailure(operation, "CIPHER_UNAVAILABLE", dependencies);
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }
  const requestSecret = await readRequestSecret(
    operation,
    driver,
    cipher,
    dependencies,
  );

  const exchangeTime = readClockNow(dependencies.clock);
  if (compareInstants(exchangeTime, operation.expiresAt) >= 0) {
    // The frozen store refuses every outcome at or after the operation's TTL, so
    // a late attempt reports expiry and leaves the residual secret to the
    // bounded maintenance sweep instead of backdating a failure record.
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
  }

  const attempt = await attemptExchange(driver, snapshot.callback, requestSecret, exchangeTime);
  if (attempt.kind === "failure") {
    await persistFailure(operation, attempt.storedErrorCode, dependencies);
    throw attempt.error;
  }
  let decoded: ExchangeValidation;
  try {
    decoded = requireExchangeResult(attempt.value);
  } catch (error) {
    await persistFailure(operation, "INVALID_RESPONSE", dependencies);
    throw authFailure(error, "PROVIDER_ERROR", "invalid_driver_response");
  }

  const encoded = encodeOAuthCandidate({
    plaintext: decoded.plaintext,
    expiresAt: decoded.expiresAt,
  });
  if (encoded.kind !== "ok") {
    await persistFailure(operation, "INVALID_RESPONSE", dependencies);
    throw new AuthUseCaseError(
      "PROVIDER_ERROR",
      encoded.reason === "oversize" ? "invalid_driver_response" : "candidate_invalid",
    );
  }
  let candidateEnvelope: Awaited<ReturnType<CredentialCipher["encrypt"]>>;
  try {
    candidateEnvelope = await encryptCandidate(
      cipher,
      operation.platform,
      operation.operationId,
      encoded.bytes,
    );
  } catch (error) {
    // The candidate cannot be stored from an unencrypted payload, but the
    // claimed operation still records that this instance lacked a usable key.
    await persistFailure(operation, "CIPHER_UNAVAILABLE", dependencies);
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }

  const completionTime = readClockNow(dependencies.clock);
  if (compareInstants(completionTime, operation.expiresAt) >= 0) {
    // A late response must not extend the operation's own lifetime, and the same
    // store rule means no backdated failure record is written either.
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
  }

  const phase = decoded.missingFields.length > 0 ? "needs_configuration" : "awaiting_confirmation";
  let commit: Awaited<ReturnType<CredentialStore["saveCandidate"]>>;
  try {
    commit = await dependencies.credentials.saveCandidate({
      operationId: operation.operationId,
      platform: operation.platform,
      now: completionTime,
      outcome: {
        kind: "candidate",
        phase,
        candidateEnvelope,
        candidatePayloadRevision: OAUTH_REQUEST_SECRET_GENERATION,
        candidatePayloadSchemaVersion: OAUTH_CANDIDATE_VERSION,
        candidateTarget: decoded.target,
        missingFields: decoded.missingFields,
      },
    });
  } catch {
    // A storage failure is a controlled error, never a success response.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  if (commit.kind !== "applied") {
    // The candidate was not stored — a competing completion, a phase that moved
    // or an expired operation — so this caller never receives a success outcome.
    throw saveCandidateFailure(commit.kind === "conflict" ? commit.reason : null);
  }

  return Object.freeze({
    platform: operation.platform,
    operationId: operation.operationId,
    phase,
    expiresAt: operation.expiresAt,
    missingFields: decoded.missingFields,
    target: decoded.target,
  });
}

/** Bound and freeze every callback value before the first await. */
function snapshotCallback(input: unknown): CallbackSnapshot {
  try {
    const record = asRecord(input);
    if (record === null || !isPlatform(record["platform"])) {
      throw new AuthUseCaseError("INVALID_REQUEST", "callback");
    }
    const state = requireParameter(record["state"]);
    if (state === null) {
      throw new AuthUseCaseError("INVALID_REQUEST", "callback");
    }
    const deniedValue = record["denied"];
    if (deniedValue !== undefined && typeof deniedValue !== "boolean") {
      throw new AuthUseCaseError("INVALID_REQUEST", "callback");
    }
    const callback: OAuthCallbackSnapshot = Object.freeze({
      platform: record["platform"],
      state,
      code: optionalParameter(record["code"]),
      verifier: optionalParameter(record["verifier"]),
      requestToken: optionalParameter(record["requestToken"]),
    });
    return Object.freeze({ callback, denied: deniedValue === true });
  } catch (error) {
    // The callback object is untrusted: a proxy trap or throwing getter must not
    // reach the caller with its own message.
    throw authFailure(error, "INVALID_REQUEST", "callback");
  }
}

/**
 * Protocol-specific callback requirements, checked before the claim.
 *
 * OAuth2 success carries `code` and nothing else; OAuth1 carries its request
 * token and a verifier, and never a `code`. A denial may omit the verifier and
 * the code, but still has to carry the values the original request used.
 * Cross-protocol parameters are rejected instead of being ignored, and every
 * value must be an exact opaque string.
 */
function requireProtocolInputs(
  callback: OAuthCallbackSnapshot,
  denied: boolean,
  protocol: "oauth1" | "oauth2",
): void {
  if (protocol === "oauth1") {
    if (callback.requestToken === null) {
      throw new AuthUseCaseError("INVALID_REQUEST", "callback");
    }
    if (callback.code !== null) {
      throw new AuthUseCaseError("INVALID_REQUEST", "callback");
    }
    if (!denied && callback.verifier === null) {
      throw new AuthUseCaseError("INVALID_REQUEST", "callback");
    }
    return;
  }
  if (callback.verifier !== null || callback.requestToken !== null) {
    throw new AuthUseCaseError("INVALID_REQUEST", "callback");
  }
  if (!denied && callback.code === null) {
    throw new AuthUseCaseError("INVALID_REQUEST", "callback");
  }
}

async function resolveCallbackDriver(
  platform: Platform,
  dependencies: Pick<OAuthCallbackDependencies, "drivers">,
): Promise<OAuthDriver> {
  let resolved: OAuthDriver | null;
  try {
    resolved = await dependencies.drivers(platform);
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "unavailable");
  }
  if (resolved === null || resolved === undefined) {
    throw new AuthUseCaseError("INVALID_REQUEST", "oauth_unsupported");
  }
  return requireDriverSnapshot(resolved, platform);
}

/** Exactly one claim; unknown, throwing and conflicting outcomes exchange nothing. */
async function claimOnce(
  callback: OAuthCallbackSnapshot,
  driver: OAuthDriver,
  now: IsoInstant,
  dependencies: OAuthCallbackDependencies,
): Promise<StoredAuthOperation> {
  let result: Awaited<ReturnType<CredentialStore["claimOAuthCallback"]>>;
  try {
    result = await dependencies.credentials.claimOAuthCallback({
      platform: callback.platform,
      oauthState: callback.state,
      requestToken: callback.requestToken,
      now,
      currentConfigBinding: driver.startConfigBinding,
    });
  } catch {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  if (result.kind === "claimed") {
    return result.operation;
  }
  if (result.kind === "unknown") {
    // The claim write result is unknown: no winner is proven, so no provider
    // call happens and nothing is retried.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  throw claimConflict(result.reason);
}

function claimConflict(reason: string): AuthUseCaseError {
  switch (reason) {
    case "request_token_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "request_token_mismatch");
    case "phase_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "operation_phase");
    case "expired":
      return new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
    case "start_config_changed":
      return new AuthUseCaseError("AUTH_CONFLICT", "config_changed");
    default:
      // not_found, platform_mismatch and state_mismatch all stay opaque.
      return new AuthUseCaseError("NOT_FOUND", "operation_not_found");
  }
}

interface IdentityFailure {
  readonly error: AuthUseCaseError;
  readonly errorCode: OAuthStoredErrorCode;
}

/**
 * Immutable identity of the claimed operation.
 *
 * The canonical callback is compared in addition to the configuration binding,
 * so an operation started for a different origin can never be completed.
 */
function operationIdentityFailure(
  operation: StoredAuthOperation,
  callback: OAuthCallbackSnapshot,
  driver: OAuthDriver,
  now: IsoInstant,
): IdentityFailure | null {
  if (operation.platform !== callback.platform || !isOpaqueId(operation.operationId)) {
    return {
      error: new AuthUseCaseError("NOT_FOUND", "operation_not_found"),
      errorCode: "INVALID_RESPONSE",
    };
  }
  if (operation.oauthState !== callback.state) {
    return {
      error: new AuthUseCaseError("NOT_FOUND", "operation_not_found"),
      errorCode: "INVALID_RESPONSE",
    };
  }
  if (operation.phase !== "exchanging") {
    return {
      error: new AuthUseCaseError("AUTH_CONFLICT", "operation_phase"),
      errorCode: "INVALID_RESPONSE",
    };
  }
  if (
    operation.startConfigBinding !== driver.startConfigBinding ||
    operation.canonicalCallbackUrl !== driver.canonicalCallbackUrl
  ) {
    return {
      error: new AuthUseCaseError("AUTH_CONFLICT", "config_changed"),
      errorCode: "CONFIG_CHANGED",
    };
  }
  if (driver.protocol === "oauth1" && operation.requestToken !== callback.requestToken) {
    return {
      error: new AuthUseCaseError("AUTH_CONFLICT", "request_token_mismatch"),
      errorCode: "TOKEN_MISMATCH",
    };
  }
  if (compareInstants(now, operation.expiresAt) >= 0) {
    return {
      error: new AuthUseCaseError("AUTH_CONFLICT", "operation_expired"),
      errorCode: "EXPIRED",
    };
  }
  return null;
}

/**
 * Decrypt the original OAuth1 request secret for the winning claimant only.
 *
 * Every failure records a fixed failure code for the claimed operation and the
 * provider is never contacted.
 */
async function readRequestSecret(
  operation: StoredAuthOperation,
  driver: OAuthDriver,
  cipher: CredentialCipher,
  dependencies: OAuthCallbackDependencies,
): Promise<Uint8Array | null> {
  if (driver.protocol !== "oauth1") {
    return null;
  }
  const envelope = operation.requestSecret;
  const revision = operation.requestSecretRevision;
  if (
    envelope === null ||
    operation.requestSecretPurpose !== "oauth_request_secret" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision <= 0
  ) {
    await persistFailure(operation, "DECRYPTION_FAILED", dependencies);
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "request_secret_unavailable");
  }
  try {
    const decrypted = await cipher.decrypt(envelope, {
      purpose: "oauth_request_secret" as const,
      recordId: operation.operationId,
      platform: operation.platform,
      payloadSchemaVersion: 1,
      payloadRevision: revision,
    });
    if (!(decrypted instanceof Uint8Array) || decrypted.byteLength === 0) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "request_secret_unavailable");
    }
    // Copy: a cipher may reuse the buffer it returned.
    return new Uint8Array(decrypted);
  } catch {
    await persistFailure(operation, "DECRYPTION_FAILED", dependencies);
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "request_secret_unavailable");
  }
}

/**
 * One exchange attempt.
 *
 * A provider failure returns the fixed error together with the fixed stored code
 * so the caller can persist it; the returned error never carries provider text.
 */
type ExchangeAttempt =
  | { readonly kind: "result"; readonly value: unknown }
  | {
      readonly kind: "failure";
      readonly error: AuthUseCaseError;
      readonly storedErrorCode: OAuthStoredErrorCode;
    };

async function attemptExchange(
  driver: OAuthDriver,
  callback: OAuthCallbackSnapshot,
  requestSecret: Uint8Array | null,
  now: IsoInstant,
): Promise<ExchangeAttempt> {
  try {
    return { kind: "result", value: await driver.exchange({ callback, requestSecret, now }) };
  } catch (error) {
    return {
      kind: "failure",
      error: new AuthUseCaseError("PROVIDER_ERROR", "provider_error"),
      storedErrorCode: storedErrorCodeFor(preserveDriverFailure(error)),
    };
  }
}

interface ExchangeValidation {
  readonly plaintext: Uint8Array;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
  readonly missingFields: readonly string[];
}

/**
 * Validate one exchange result.

 * The plaintext buffer is copied, the expiry must be canonical or null, the
 * target must be safe metadata and the missing-field list must come from the
 * closed candidate allowlist.
 */
function requireExchangeResult(value: unknown): ExchangeValidation {
  try {
    if (typeof value !== "object" || value === null) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    const record = value as Record<string, unknown>;
    const plaintext = record["plaintext"];
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    const expiresAt = record["expiresAt"];
    if (expiresAt !== null && !isIsoInstant(expiresAt)) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    const missingFields = safeMissingFields(record["missingFields"]);
    if (missingFields === null) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    return {
      // Copy: a driver may reuse the buffer it returned.
      plaintext: new Uint8Array(plaintext),
      expiresAt,
      target: requireSafeTarget(record["target"]),
      missingFields,
    };
  } catch (error) {
    throw authFailure(error, "PROVIDER_ERROR", "invalid_driver_response");
  }
}

function requireSafeTarget(value: unknown): SafeTarget | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  const record = value as Record<string, unknown>;
  const label = record["label"];
  const source = record["source"];
  if (
    typeof label !== "string" ||
    label.trim() === "" ||
    label.length > MAX_TARGET_LABEL_LENGTH ||
    CONTROL_CHARACTER.test(label)
  ) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  if (source !== "user" && source !== "provider") {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  return Object.freeze({ label, source });
}

/**
 * Encrypt the candidate envelope under the operation-scoped candidate context.
 *
 * A cipher failure leaves the claimed operation in `exchanging` for maintenance;
 * no candidate is stored from an unencrypted payload.
 */
async function encryptCandidate(
  cipher: CredentialCipher,
  platform: Platform,
  operationId: string,
  candidateBytes: Uint8Array,
): Promise<Awaited<ReturnType<CredentialCipher["encrypt"]>>> {
  try {
    const envelope = await cipher.encrypt(candidateBytes, {
      purpose: "oauth_candidate" as const,
      recordId: operationId,
      platform,
      payloadSchemaVersion: OAUTH_CANDIDATE_VERSION,
      payloadRevision: OAUTH_REQUEST_SECRET_GENERATION,
    });
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      envelope.version !== 1 ||
      envelope.algorithm !== "AES-256-GCM" ||
      typeof envelope.keyId !== "string" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
    }
    return envelope;
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

/**
 * Fixed failure record for a claimed operation; never a success response.
 *
 * The observation time is read *inside* this function: a caller's earlier
 * timestamp (captured before an awaited decrypt or exchange) must never be used
 * to backdate a record into an operation whose window has already passed. The
 * frozen store additionally refuses every outcome at or after `expiresAt`, so a
 * late attempt performs no write at all: the read projection reports the expired
 * operation and the bounded maintenance sweep clears the residual request
 * secret.
 *
 * The commit result is inspected: a conflict means the row moved under us and
 * nothing is implied, and a thrown storage failure is a controlled error.
 */
async function persistFailure(
  operation: StoredAuthOperation,
  errorCode: OAuthStoredErrorCode,
  dependencies: OAuthCallbackDependencies,
): Promise<boolean> {
  const now = readClockNow(dependencies.clock);
  if (compareInstants(now, operation.expiresAt) >= 0) {
    return false;
  }
  let result: Awaited<ReturnType<CredentialStore["saveCandidate"]>>;
  try {
    result = await dependencies.credentials.saveCandidate({
      operationId: operation.operationId,
      platform: operation.platform,
      now,
      outcome: { kind: "failed", errorCode },
    });
  } catch {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  return result.kind !== "conflict";
}

/** Map a non-applied candidate commit; the candidate is not stored. */
function saveCandidateFailure(reason: string | null): AuthUseCaseError {
  switch (reason) {
    case "operation_expired":
      return new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
    case "not_found":
      return new AuthUseCaseError("NOT_FOUND", "operation_not_found");
    case "phase_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "operation_phase");
    default:
      return new AuthUseCaseError("AUTH_CONFLICT", "unexpected_result");
  }
}

function requireUsableCipher(
  dependencies: Pick<OAuthCallbackDependencies, "getCipher">,
): CredentialCipher {
  try {
    const cipher = dependencies.getCipher();
    if (cipher === null || cipher === undefined || typeof cipher.encrypt !== "function") {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
    }
    return cipher;
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

function requireParameter(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  // Exact opaque strings only: whitespace is rejected rather than trimmed into
  // something that could match a stored state or token.
  if (value === "" || value.length > MAX_PARAMETER_LENGTH || value !== value.trim()) {
    return null;
  }
  if (CONTROL_CHARACTER.test(value)) {
    return null;
  }
  return value;
}

/**
 * Optional callback parameter.
 *
 * Absent means null; a present but invalid value (non-string, empty, oversized
 * or containing control characters) is rejected instead of being silently
 * dropped, so a malformed provider redirect cannot pass as "no parameter".
 */
function optionalParameter(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = requireParameter(value);
  if (parsed === null) {
    throw new AuthUseCaseError("INVALID_REQUEST", "callback");
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
