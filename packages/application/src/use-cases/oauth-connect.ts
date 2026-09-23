/**
 * Portable OAuth connect.
 *
 * Order is part of the contract:
 *
 * 1. Snapshot and validate the caller's intent synchronously.
 * 2. Resolve the immutable driver snapshot for the platform. The resolver may be
 *    asynchronous because a real configuration fingerprint uses WebCrypto HMAC;
 *    nothing else happens before it resolves, and a null driver means this build
 *    has no OAuth flow for the platform.
 * 3. Read the slot once and check the observed revision, so a stale operator
 *    never starts an authorization.
 * 4. Snapshot the creation time, derive the 30-minute expiry and generate two
 *    distinct unpredictable identifiers.
 * 5. Check the credential cipher/key before any request-token call. OAuth1 needs
 *    the cipher for the request secret, and the check is not skipped for OAuth2
 *    because the same instance must encrypt the candidate later.
 * 6. Perform exactly one `begin` call and copy its buffers.
 * 7. Encrypt the request secret only after `begin` supplied it, re-read the clock
 *    and refuse to save an already expired operation.
 * 8. Create the operation exactly once. A write failure returns a controlled
 *    error, never a usable receipt, and is never retried.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import type { CipherContext, EncryptedCredential } from "../contracts/credentials.js";
import {
  AUTH_OPERATION_TTL_MS,
  InvalidContractInputError,
  compareInstants,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "../contracts/primitives.js";
import { assertEncryptedEnvelopeShape, type CredentialCipher } from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import { AuthUseCaseError, authFailure } from "./auth-errors.js";
import type { OAuthDriver, OAuthDriverResolver } from "./oauth-driver.js";
import { readTrustedSlot } from "./prepare-publisher.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

/** Generation of the encrypted OAuth1 request secret. */
export const OAUTH_REQUEST_SECRET_GENERATION = 1;

export type OAuthIdKind = "oauth_state" | "operation_id";

/** Injected unpredictable identifiers; the two kinds never share a value. */
export type OAuthIdFactory = (kind: OAuthIdKind) => string;

export interface OAuthConnectDependencies {
  readonly credentials: CredentialStore;
  readonly getCipher: () => CredentialCipher;
  /** Sync or async: a real configuration fingerprint may use WebCrypto. */
  readonly drivers: OAuthDriverResolver;
  readonly clock: UseCaseClock;
  readonly ids: OAuthIdFactory;
}

export interface OAuthConnectInput {
  readonly platform: Platform;
  /** Operator-observed slot revision, or null/absent for compatibility. */
  readonly expectedRevision?: number | null;
}

/** Authenticated interactive receipt; the only place a provider URL appears. */
export interface OAuthConnectReceipt {
  readonly platform: Platform;
  readonly operationId: string;
  readonly url: string;
  readonly expiresAt: IsoInstant;
  readonly expectedRevision: number;
}

const MAX_URL_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 512;
const MIN_BINDING_LENGTH = 16;
const BINDING_PATTERN = /^[A-Za-z0-9._:+/=-]{16,256}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export async function beginOAuthConnect(
  input: OAuthConnectInput,
  dependencies: OAuthConnectDependencies,
): Promise<OAuthConnectReceipt> {
  // Snapshot the caller's intent before the first await.
  let platform: Platform;
  let expectedRevision: number | null;
  try {
    platform = requirePlatform(input);
    expectedRevision = requireOptionalRevision(input);
  } catch (error) {
    throw authFailure(error, "INVALID_REQUEST", "credential_body");
  }

  const driver = await resolveDriverSnapshot(platform, dependencies);
  const slot = await readTrustedSlot(platform, dependencies);
  const observedRevision = expectedRevision ?? slot.revision;
  if (observedRevision !== slot.revision) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
  }

  const creationTime = readClockNow(dependencies.clock);
  const expiresAt = plusMilliseconds(creationTime, AUTH_OPERATION_TTL_MS);
  const state = requireOpaqueId(dependencies.ids("oauth_state"), "oauth state factory");
  const operationId = requireOpaqueId(dependencies.ids("operation_id"), "operation id factory");
  if (state === operationId) {
    throw new InvalidContractInputError("oauth state and operation id must be distinct values");
  }

  // Key readiness is proven before any provider call, for both protocols.
  const cipher = requireUsableCipher(dependencies);
  const begun = await runBegin(driver, state, creationTime);
  const requestToken = requireOptionalToken(begun.requestToken);
  const requestSecret = copySecret(begun.requestSecret);
  const authorizationUrl = requireAuthorizationUrl(begun.authorizationUrl);
  if (driver.protocol === "oauth1" && (requestToken === null || requestSecret === null)) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  if (driver.protocol === "oauth2" && (requestToken !== null || requestSecret !== null)) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }

  const afterBegin = readClockNow(dependencies.clock);
  if (compareInstants(afterBegin, expiresAt) >= 0) {
    // The request-token acquisition outlived its own window; nothing is created.
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
  }

  const requestSecretEnvelope =
    driver.protocol === "oauth1" && requestSecret !== null
      ? await encryptRequestSecret(cipher, platform, operationId, requestSecret)
      : null;

  const afterEncrypt = readClockNow(dependencies.clock);
  if (compareInstants(afterEncrypt, expiresAt) >= 0) {
    // The awaited encryption also happens after network work; an operation whose
    // window elapsed while it ran is never created.
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
  }

  try {
    await dependencies.credentials.createAuthOperation({
      operationId,
      platform,
      now: creationTime,
      expectedRevision: observedRevision,
      canonicalCallbackUrl: driver.canonicalCallbackUrl,
      startConfigBinding: driver.startConfigBinding,
      oauthState: state,
      requestToken,
      requestSecret: requestSecretEnvelope,
      requestSecretPurpose: requestSecretEnvelope === null ? null : "oauth_request_secret",
      requestSecretRevision: requestSecretEnvelope === null ? null : OAUTH_REQUEST_SECRET_GENERATION,
      expiresAt,
    });
  } catch {
    // One attempt only: a failed or lost write never produces a receipt and
    // never repeats request-token acquisition.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }

  return Object.freeze({
    platform,
    operationId,
    url: authorizationUrl,
    expiresAt,
    expectedRevision: observedRevision,
  });
}

/**
 * Resolve the immutable driver snapshot.
 *
 * Returning null means this build has no OAuth flow for the platform. Throwing
 * means mapped instance configuration is missing or invalid, which is an
 * instance-readiness problem rather than a caller problem.
 */
async function resolveDriverSnapshot(
  platform: Platform,
  dependencies: Pick<OAuthConnectDependencies, "drivers">,
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

/**
 * Validate the snapshot the application is about to trust.
 *
 * The driver is injected, so its identity fields are checked before they become
 * the AAD identity, the stored callback URL or the configuration binding.
 */
export function requireDriverSnapshot(value: unknown, platform: Platform): OAuthDriver {
  try {
    if (typeof value !== "object" || value === null) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    const candidate = value as Record<string, unknown>;
    const driverPlatform = candidate["platform"];
    const protocol = candidate["protocol"];
    if (
      driverPlatform !== platform ||
      (protocol !== "oauth1" && protocol !== "oauth2")
    ) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    const canonicalCallbackUrl = requireCanonicalCallbackUrl(candidate["canonicalCallbackUrl"]);
    const startConfigBinding = requireStartConfigBinding(candidate["startConfigBinding"]);
    const begin = candidate["begin"];
    const exchange = candidate["exchange"];
    const confirm = candidate["confirm"];
    const refresh = candidate["refresh"];
    if (
      typeof begin !== "function" ||
      typeof exchange !== "function" ||
      typeof confirm !== "function"
    ) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    if (refresh !== undefined && typeof refresh !== "function") {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    // Capture identity and method references once, bound to the original
    // receiver: a later mutation of the injected object cannot change this
    // operation's identity or hand us a different implementation mid-flight.
    // The casts only restore the checked method signatures to `unknown` values
    // that the `typeof` guard above has already proven callable.
    const beginMethod = (begin as OAuthDriver["begin"]).bind(value);
    const exchangeMethod = (exchange as OAuthDriver["exchange"]).bind(value);
    const confirmMethod = (confirm as OAuthDriver["confirm"]).bind(value);
    const snapshot: OAuthDriver = {
      platform,
      protocol,
      canonicalCallbackUrl,
      startConfigBinding,
      begin: beginMethod,
      exchange: exchangeMethod,
      confirm: confirmMethod,
      ...(typeof refresh === "function"
        ? { refresh: (refresh as NonNullable<OAuthDriver["refresh"]>).bind(value) }
        : {}),
    };
    return Object.freeze(snapshot);
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "invalid_driver_response");
  }
}

interface RawBeginResult {
  readonly authorizationUrl: unknown;
  readonly requestToken: unknown;
  readonly requestSecret: unknown;
}

async function runBegin(
  driver: OAuthDriver,
  state: string,
  now: IsoInstant,
): Promise<RawBeginResult> {
  let result: unknown;
  try {
    result = await driver.begin({ state, now });
  } catch {
    // A provider denial, timeout or malformed response becomes one fixed code;
    // the driver's own text and cause never travel.
    throw new AuthUseCaseError("PROVIDER_ERROR", "provider_error");
  }
  try {
    if (typeof result !== "object" || result === null) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    const record = result as Record<string, unknown>;
    return {
      authorizationUrl: record["authorizationUrl"],
      requestToken: record["requestToken"],
      requestSecret: record["requestSecret"],
    };
  } catch (error) {
    throw authFailure(error, "PROVIDER_ERROR", "invalid_driver_response");
  }
}

function requireAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  if (url.protocol !== "https:") {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  return value;
}

/**
 * Validate the canonical callback origin once, before it becomes the AAD
 * identity of the operation.
 *
 * Only a normalized HTTPS URL without userinfo, query or fragment is accepted,
 * and whitespace is rejected rather than trimmed.
 */
function requireCanonicalCallbackUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    CONTROL_CHARACTER.test(value) ||
    value !== value.trim()
  ) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  return value;
}

/**
 * Validate the configuration fingerprint the operation is pinned to.

 * A meaningful binding is a bounded token-like value: short placeholders,
 * whitespace and control characters are refused instead of being signed as if
 * they identified a configuration.
 */
function requireStartConfigBinding(value: unknown): string {
  if (typeof value !== "string" || value.length < MIN_BINDING_LENGTH) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  if (!BINDING_PATTERN.test(value)) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  return value;
}

function requireOptionalToken(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  return value;
}

function copySecret(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
  }
  // Copy: a driver may reuse the buffer it returned.
  return new Uint8Array(value);
}

async function encryptRequestSecret(
  cipher: CredentialCipher,
  platform: Platform,
  operationId: string,
  requestSecret: Uint8Array,
): Promise<EncryptedCredential> {
  const context: CipherContext = Object.freeze({
    purpose: "oauth_request_secret" as const,
    // Operation-scoped identity: the opaque operation id, never the platform.
    recordId: operationId,
    platform,
    payloadSchemaVersion: 1,
    payloadRevision: OAUTH_REQUEST_SECRET_GENERATION,
  });
  try {
    const envelope = await cipher.encrypt(requestSecret, context);
    assertEncryptedEnvelopeShape(envelope);
    return envelope;
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

function requireUsableCipher(
  dependencies: Pick<OAuthConnectDependencies, "getCipher">,
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

function requirePlatform(input: unknown): Platform {
  const record = asRecord(input);
  if (record === null || !isPlatform(record["platform"])) {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
  return record["platform"];
}

function requireOptionalRevision(input: unknown): number | null {
  const record = asRecord(input);
  if (record === null) {
    throw new AuthUseCaseError("INVALID_REQUEST", "expected_revision");
  }
  const value = record["expectedRevision"];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthUseCaseError("INVALID_REQUEST", "expected_revision");
  }
  return value;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (!isOpaqueId(value)) {
    throw new InvalidContractInputError(`${label} must return a bounded opaque identifier`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function plusMilliseconds(instant: IsoInstant, milliseconds: number): IsoInstant {
  const next = new Date(Date.parse(instant) + milliseconds).toISOString();
  if (!isIsoInstant(next)) {
    throw new InvalidContractInputError("operation expiry is not a representable instant");
  }
  return next;
}
