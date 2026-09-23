/**
 * Portable OAuth candidate completion and activation.
 *
 * No network work happens here: the only external calls are the injected
 * synchronous `confirm`, the credential cipher and one `activateCandidate`.
 *
 * Order is part of the contract:
 *
 * 1. Snapshot and validate the caller's intent synchronously: platform,
 *    operation id, observed revision and optional explicit target.
 * 2. Read the operation once, snapshot its fields defensively and validate both
 *    its operation id and platform before any phase check or decryption.
 * 3. **Replay first**: a completed operation returns its stored receipt with
 *    `replayed: true` before any key, driver, slot, target or expiry check, and
 *    never needs a slot read, generation or binding.
 * 4. Otherwise the operation must be awaiting confirmation, unexpired, and carry
 *    a readable candidate of the supported version.
 * 5. The caller's revision must equal the operation's initial revision and the
 *    current slot revision, and the driver snapshot must still match the
 *    operation's configuration binding and canonical callback.
 * 6. The candidate is decrypted with the operation-scoped AAD, decoded strictly
 *    and confirmed by the driver with the caller's explicit target. An old
 *    active target or an ordinary preparation default is never inherited.
 * 7. A new binding id and the next safe payload generation are created before
 *    encryption, the confirmed plaintext is encrypted under the active-slot AAD
 *    and the receipt is projected from the *proposed* committed snapshot.
 * 8. One `activateCandidate` carries the slot write, the new connection identity
 *    and the receipt atomically. A conflict leaves everything unchanged and a
 *    lost acknowledgement is recovered only by an explicit same-operation
 *    replay, never by an automatic retry or exchange.
 *
 * Internal naming note: the confirmation target uses camelCase `apiVersion`
 * inside application code; the HTTP decoder maps the wire field `api_version`
 * onto it, and the driver performs the platform-specific validation.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import type {
  CipherContext,
  EncryptedCredential,
  EncryptedSlotSnapshot,
  SlotChange,
  StoredAuthOperation,
} from "../contracts/credentials.js";
import {
  InvalidContractInputError,
  compareInstants,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { AuthPhase, CompleteReceiptRecord, Readiness, SafeTarget } from "../contracts/status.js";
import { assertEncryptedEnvelopeShape, type CredentialCipher } from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { PlatformConfigView, PlatformStrategyRegistry } from "../ports/publisher-strategy.js";
import { AuthUseCaseError, authFailure } from "./auth-errors.js";
import { nextPayloadRevision, projectStatus } from "./direct-credentials.js";
import {
  OAUTH_CANDIDATE_VERSION,
  decodeOAuthCandidate,
  type OAuthCandidatePayload,
} from "./oauth-candidate.js";
import { requireDriverSnapshot } from "./oauth-connect.js";
import {
  safeMissingFields,
  type OAuthDriver,
  type OAuthDriverResolver,
  type OAuthTargetOverrides,
} from "./oauth-driver.js";
import { readTrustedSlot } from "./prepare-publisher.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

/** Schema generation of the native active-slot credential payload. */
export const ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION = 1;

export interface CompleteOAuthOperationInput {
  readonly platform: Platform;
  readonly operationId: string;
  /** Revision the operator observed; must match the operation and the slot. */
  readonly expectedRevision: number;
  /**
   * Explicit confirmation target (wire `target`):
   * `{ author?, api_version?, blog? }` maps to `apiVersion` here.
   */
  readonly target?: {
    readonly author?: string | null;
    readonly apiVersion?: string | null;
    readonly blog?: string | null;
  } | null;
}

export interface CompleteOAuthOperationDependencies {
  readonly credentials: CredentialStore;
  /** Lazy: a completed-operation replay never needs a working key. */
  readonly getCipher: () => CredentialCipher;
  readonly drivers: OAuthDriverResolver;
  readonly strategies: PlatformStrategyRegistry;
  readonly configFor: (platform: Platform) => PlatformConfigView;
  readonly clock: UseCaseClock;
  /** New connection identity; called at most once per activation attempt. */
  readonly bindingIds: () => string;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_TARGET_LENGTH = 256;
const PHASES: readonly AuthPhase[] = Object.freeze([
  "pending_callback",
  "exchanging",
  "awaiting_confirmation",
  "needs_configuration",
  "completed",
  "failed",
  "expired",
]);
const READINESS_VALUES: readonly Readiness[] = Object.freeze([
  "ready",
  "missing_credentials",
  "needs_configuration",
  "expired",
  "reconnect_required",
  "unavailable",
]);

interface ConfirmedCredential {
  readonly plaintext: Uint8Array;
  readonly target: SafeTarget | null;
}

interface SnapshotInput {
  readonly platform: Platform;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly target: OAuthTargetOverrides;
}

interface OperationSnapshot {
  readonly operationId: string;
  readonly platform: Platform;
  readonly phase: AuthPhase;
  readonly expectedRevision: number;
  readonly expiresAt: IsoInstant;
  readonly startConfigBinding: string;
  readonly canonicalCallbackUrl: string;
  readonly candidateEnvelope: EncryptedCredential | null;
  readonly candidatePayloadRevision: number | null;
  readonly candidatePayloadSchemaVersion: number | null;
  readonly receipt: unknown;
}

export async function completeOAuthOperation(
  input: CompleteOAuthOperationInput,
  dependencies: CompleteOAuthOperationDependencies,
): Promise<CompleteReceiptRecord> {
  // Snapshot the caller's intent before the first await.
  let snapshot: SnapshotInput;
  try {
    snapshot = snapshotInput(input);
  } catch (error) {
    throw authFailure(error, "INVALID_REQUEST", "platform");
  }

  const operation = await readOperation(snapshot.platform, snapshot.operationId, dependencies);

  // Replay: a completed operation returns its stored receipt before any key,
  // configuration, slot, target-requirement or expiry check.
  if (operation.phase === "completed") {
    return replayReceipt(operation, snapshot.platform, snapshot.operationId);
  }
  if (operation.phase !== "awaiting_confirmation" && operation.phase !== "needs_configuration") {
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_phase");
  }

  const driver = await resolveDriver(snapshot.platform, operation, dependencies);
  const slot = await readTrustedSlot(snapshot.platform, dependencies);
  if (
    snapshot.expectedRevision !== operation.expectedRevision ||
    snapshot.expectedRevision !== slot.revision
  ) {
    // A stale confirmation can never revive an older authorization or replace a
    // newer connection; nothing is decrypted or written.
    throw new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
  }

  const openedAt = readClockNow(dependencies.clock);
  if (compareInstants(openedAt, operation.expiresAt) >= 0) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
  }

  const cipher = requireUsableCipher(dependencies);
  const payload = await openCandidate(operation, cipher, snapshot.platform);
  if (payload.expiresAt !== null && compareInstants(payload.expiresAt, openedAt) <= 0) {
    // An expired provider grant cannot become the active credential.
    throw new AuthUseCaseError("AUTH_CONFLICT", "candidate_expired");
  }

  const confirmed = runConfirm(driver, payload.plaintext, snapshot.target, openedAt);
  const payloadRevision = nextPayloadRevision(slot);
  const bindingId = createBindingId(dependencies);
  const envelope = await encryptActiveCredential(
    cipher,
    snapshot.platform,
    confirmed.plaintext,
    payloadRevision,
  );

  const completionTime = readClockNow(dependencies.clock);
  if (compareInstants(completionTime, operation.expiresAt) >= 0) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
  }
  if (payload.expiresAt !== null && compareInstants(payload.expiresAt, completionTime) <= 0) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "candidate_expired");
  }

  const proposedRevision = slot.revision + 1;
  // The receipt describes the snapshot this activation proposes, never a later
  // read that could observe another winner.
  const committed = proposedActiveSlot(
    snapshot.platform,
    proposedRevision,
    bindingId,
    envelope,
    payloadRevision,
    payload.expiresAt,
    confirmed.target,
    completionTime,
  );
  const status = projectStatus(
    snapshot.platform,
    committed,
    confirmed.plaintext,
    completionTime,
    dependencies,
  );
  const receipt: CompleteReceiptRecord = Object.freeze({
    platform: snapshot.platform,
    operationId: snapshot.operationId,
    stored: true as const,
    revision: proposedRevision,
    configured: status.configured === true,
    readiness: status.readiness,
  });

  let result: Awaited<ReturnType<CredentialStore["activateCandidate"]>>;
  try {
    result = await dependencies.credentials.activateCandidate({
      operationId: snapshot.operationId,
      platform: snapshot.platform,
      now: completionTime,
      expectedRevision: snapshot.expectedRevision,
      bindingId,
      currentConfigBinding: driver.startConfigBinding,
      envelope,
      payloadRevision,
      payloadSchemaVersion: ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION,
      expiresAt: payload.expiresAt,
      target: confirmed.target,
      receipt,
    });
  } catch {
    // One attempt only: a lost acknowledgement is resolved by an explicit
    // same-operation replay, never by an automatic retry or token exchange.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }

  if (result.kind === "conflict") {
    throw activationConflict(result.reason);
  }
  if (result.kind !== "activated" && result.kind !== "replayed") {
    // A store that answers with anything else cannot be trusted for a receipt.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "unexpected_result");
  }
  const stored = requireStoredReceipt(result.receipt, snapshot.platform, snapshot.operationId);
  if (result.kind === "activated") {
    if (result.revision !== proposedRevision || stored.revision !== proposedRevision) {
      // The stored revision must be the one this activation proposed; nothing is
      // inferred from the live slot.
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    return stored;
  }
  if (result.revision !== stored.revision) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  return Object.freeze({ ...stored, replayed: true });
}

function snapshotInput(input: unknown): SnapshotInput {
  const record = asRecord(input);
  if (record === null || !isPlatform(record["platform"])) {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
  const operationId = record["operationId"];
  if (!isOpaqueId(operationId)) {
    throw new AuthUseCaseError("NOT_FOUND", "operation_not_found");
  }
  const expectedRevision = record["expectedRevision"];
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new AuthUseCaseError("INVALID_REQUEST", "expected_revision");
  }
  return Object.freeze({
    platform: record["platform"],
    operationId,
    expectedRevision,
    target: readTargetOverrides(record["target"]),
  });
}

/**
 * Validate the caller's explicit target.
 *
 * Values are bounded, control-free strings or null. The platform-specific
 * meaning ("LinkedIn author + api_version", "Tumblr blog", "X rejects
 * overrides") belongs to the injected driver's `confirm`, which is the single
 * owner of platform target validation.
 */
function readTargetOverrides(value: unknown): OAuthTargetOverrides {
  if (value === null || value === undefined) {
    return Object.freeze({ author: null, apiVersion: null, blog: null });
  }
  const record = asRecord(value);
  if (record === null) {
    throw new AuthUseCaseError("INVALID_REQUEST", "target");
  }
  for (const key of Object.keys(record)) {
    if (key !== "author" && key !== "apiVersion" && key !== "blog") {
      throw new AuthUseCaseError("INVALID_REQUEST", "target");
    }
  }
  return Object.freeze({
    author: readTargetValue(record["author"]),
    apiVersion: readTargetValue(record["apiVersion"]),
    blog: readTargetValue(record["blog"]),
  });
}

function readTargetValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TARGET_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new AuthUseCaseError("INVALID_REQUEST", "target");
  }
  return value;
}

/**
 * Read and snapshot the operation.
 *
 * Both the requested operation id and the platform are validated before any
 * phase check, decryption or activation: a record whose id does not match the
 * request is corruption, and a record for another platform stays
 * indistinguishable from a missing one.
 */
async function readOperation(
  platform: Platform,
  operationId: string,
  dependencies: CompleteOAuthOperationDependencies,
): Promise<OperationSnapshot> {
  let read: unknown = null;
  try {
    read = await dependencies.credentials.readAuthOperation({ operationId });
  } catch {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  if (read === null || read === undefined) {
    throw new AuthUseCaseError("NOT_FOUND", "operation_not_found");
  }
  let record: Record<string, unknown>;
  try {
    const candidate = asRecord(read);
    if (candidate === null) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    record = candidate;
    if (record["platform"] !== platform) {
      throw new AuthUseCaseError("NOT_FOUND", "operation_not_found");
    }
    if (record["operationId"] !== operationId) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    const phase = record["phase"];
    const expectedRevision = record["expectedRevision"];
    const expiresAt = record["expiresAt"];
    const startConfigBinding = record["startConfigBinding"];
    const canonicalCallbackUrl = record["canonicalCallbackUrl"];
    if (
      typeof phase !== "string" ||
      !(PHASES as readonly string[]).includes(phase) ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !isIsoInstant(expiresAt) ||
      typeof startConfigBinding !== "string" ||
      startConfigBinding.length === 0 ||
      typeof canonicalCallbackUrl !== "string" ||
      canonicalCallbackUrl.length === 0
    ) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    return Object.freeze({
      operationId,
      platform,
      phase: phase as AuthPhase,
      expectedRevision,
      expiresAt,
      startConfigBinding,
      canonicalCallbackUrl,
      candidateEnvelope: readEnvelopeValue(record["candidateEnvelope"]),
      candidatePayloadRevision: readCountValue(record["candidatePayloadRevision"]),
      candidatePayloadSchemaVersion: readCountValue(record["candidatePayloadSchemaVersion"]),
      receipt: record["receipt"] ?? null,
    });
  } catch (error) {
    // A hostile record object must not escape with its own message or value.
    throw authFailure(error, "STORE_UNAVAILABLE", "corrupt_record");
  }
}

function readCountValue(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  return value;
}

function readEnvelopeValue(value: unknown): EncryptedCredential | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  return value as EncryptedCredential;
}

/** Stored receipt of a completed operation, validated before it is exposed. */
function replayReceipt(
  operation: OperationSnapshot,
  platform: Platform,
  operationId: string,
): CompleteReceiptRecord {
  if (operation.receipt === null || operation.receipt === undefined) {
    // Never guess a receipt from the live slot: a completed operation without
    // its stored receipt is a corrupt record.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  const stored = requireStoredReceipt(operation.receipt, platform, operationId);
  return Object.freeze({ ...stored, replayed: true });
}

/**
 * Validate a stored or returned receipt strictly.
 *
 * Identity must match the operation, `stored` must be true, the revision must be
 * a non-negative safe integer, `configured` must be a boolean and readiness must
 * be one of the closed enum values. Nothing is coerced and nothing is inferred
 * from the current slot.
 */
function requireStoredReceipt(
  value: unknown,
  platform: Platform,
  operationId: string,
): CompleteReceiptRecord {
  try {
    const record = asRecord(value);
    if (record === null) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    if (
      record["platform"] !== platform ||
      record["operationId"] !== operationId ||
      record["stored"] !== true
    ) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    const revision = record["revision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    const configured = record["configured"];
    if (typeof configured !== "boolean") {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    const readiness = record["readiness"];
    if (typeof readiness !== "string" || !(READINESS_VALUES as readonly string[]).includes(readiness)) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    return Object.freeze({
      platform,
      operationId,
      stored: true as const,
      revision,
      configured,
      readiness: readiness as Readiness,
    });
  } catch (error) {
    throw authFailure(error, "STORE_UNAVAILABLE", "corrupt_record");
  }
}

async function resolveDriver(
  platform: Platform,
  operation: OperationSnapshot,
  dependencies: CompleteOAuthOperationDependencies,
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
  const driver = requireDriverSnapshot(resolved, platform);
  if (
    driver.startConfigBinding !== operation.startConfigBinding ||
    driver.canonicalCallbackUrl !== operation.canonicalCallbackUrl
  ) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "config_changed");
  }
  return driver;
}

/** Decrypt and strictly decode the stored candidate under its own identity. */
async function openCandidate(
  operation: OperationSnapshot,
  cipher: CredentialCipher,
  platform: Platform,
): Promise<OAuthCandidatePayload> {
  const envelope = operation.candidateEnvelope;
  const revision = operation.candidatePayloadRevision;
  if (
    envelope === null ||
    operation.candidatePayloadSchemaVersion !== OAUTH_CANDIDATE_VERSION ||
    revision === null ||
    revision <= 0
  ) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  const context: CipherContext = Object.freeze({
    purpose: "oauth_candidate" as const,
    // Operation-scoped identity: the requested operation id, not the platform.
    recordId: operation.operationId,
    platform,
    payloadSchemaVersion: OAUTH_CANDIDATE_VERSION,
    payloadRevision: revision,
  });
  let plaintext: Uint8Array;
  try {
    // Copy: a cipher may reuse the buffer it returned.
    plaintext = new Uint8Array(await cipher.decrypt(envelope, context));
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
  }
  const decoded = decodeOAuthCandidate(plaintext);
  if (decoded.kind !== "ok") {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "candidate_invalid");
  }
  return decoded.payload;
}

/**
 * Synchronous confirmation.
 *
 * A thenable return value is a contract violation: the driver must not perform
 * network work here. The returned promise is never awaited, and its rejection is
 * disposed so a hostile driver cannot leave an unhandled rejection behind.
 */
function runConfirm(
  driver: OAuthDriver,
  candidate: Uint8Array,
  target: OAuthTargetOverrides,
  now: IsoInstant,
): ConfirmedCredential {
  let result: unknown;
  try {
    result = driver.confirm({ candidate, target, now });
  } catch (error) {
    // A rejected confirmation is a bad or incomplete target, never a provider
    // failure: confirm performs no network work.
    throw authFailure(error, "INVALID_REQUEST", "target");
  }
  try {
    const record = asRecord(result);
    if (record === null) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    if (typeof record["then"] === "function") {
      disposeRejection(result);
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    const plaintext = record["plaintext"];
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    const missingFields = safeMissingFields(record["missingFields"]);
    if (missingFields === null) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    if (missingFields.length > 0) {
      // The platform still requires an explicit target value: the operator must
      // confirm again instead of inheriting an old active target.
      throw new AuthUseCaseError("AUTH_CONFLICT", "target_required");
    }
    return Object.freeze({
      // Copy: a driver may reuse the buffer it returned.
      plaintext: new Uint8Array(plaintext),
      target: readConfirmedTarget(record["target"]),
    });
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "invalid_driver_response");
  }
}

/** Never awaited; attached only so a rejected value cannot escape. */
function disposeRejection(value: unknown): void {
  try {
    void Promise.resolve(value as PromiseLike<unknown>).catch(() => undefined);
  } catch {
    // A thenable whose `then` throws is already reported as a fixed violation.
  }
}

function readConfirmedTarget(value: unknown): SafeTarget | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  const record = value as Record<string, unknown>;
  const label = record["label"];
  const source = record["source"];
  if (
    typeof label !== "string" ||
    label.trim() === "" ||
    label.length > MAX_TARGET_LENGTH ||
    CONTROL_CHARACTER.test(label)
  ) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  if (source !== "user" && source !== "provider") {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
  }
  return Object.freeze({ label, source });
}

function createBindingId(dependencies: CompleteOAuthOperationDependencies): string {
  const value = dependencies.bindingIds();
  if (!isOpaqueId(value)) {
    // Wiring defect: the injected factory must produce a bounded opaque id.
    throw new InvalidContractInputError(
      "binding id factory must return a bounded opaque identifier",
    );
  }
  return value;
}

async function encryptActiveCredential(
  cipher: CredentialCipher,
  platform: Platform,
  plaintext: Uint8Array,
  payloadRevision: number,
): Promise<EncryptedCredential> {
  const context: CipherContext = Object.freeze({
    purpose: "active_slot" as const,
    // Runtime convention: the record id of an active slot is the platform value.
    recordId: platform,
    platform,
    payloadSchemaVersion: ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION,
    payloadRevision,
  });
  try {
    const envelope = await cipher.encrypt(plaintext, context);
    assertEncryptedEnvelopeShape(envelope);
    return envelope;
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

/** The active snapshot this activation proposes, used only for the receipt. */
function proposedActiveSlot(
  platform: Platform,
  revision: number,
  bindingId: string,
  envelope: EncryptedCredential,
  payloadRevision: number,
  expiresAt: IsoInstant | null,
  target: SafeTarget | null,
  now: IsoInstant,
): EncryptedSlotSnapshot {
  const change: Extract<SlotChange, { kind: "set" }> = {
    kind: "set",
    bindingId,
    envelope,
    payloadRevision,
    payloadSchemaVersion: ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION,
    expiresAt,
    target,
  };
  return Object.freeze({
    platform,
    status: "active" as const,
    revision,
    bindingId: change.bindingId,
    envelope: change.envelope,
    payloadRevision: change.payloadRevision,
    payloadSchemaVersion: change.payloadSchemaVersion,
    expiresAt: change.expiresAt,
    target: change.target,
    refreshLease: null,
    refreshState: "ready" as const,
    lastRefreshCommitFingerprint: null,
    updatedAt: now,
  });
}

function activationConflict(reason: string): AuthUseCaseError {
  switch (reason) {
    case "platform_mismatch":
    case "not_found":
      return new AuthUseCaseError("NOT_FOUND", "operation_not_found");
    case "revision_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
    case "operation_expired":
      return new AuthUseCaseError("AUTH_CONFLICT", "operation_expired");
    case "start_config_changed":
      return new AuthUseCaseError("AUTH_CONFLICT", "config_changed");
    case "target_required":
      return new AuthUseCaseError("AUTH_CONFLICT", "target_required");
    default:
      return new AuthUseCaseError("AUTH_CONFLICT", "operation_phase");
  }
}

function requireUsableCipher(
  dependencies: CompleteOAuthOperationDependencies,
): CredentialCipher {
  try {
    const cipher = dependencies.getCipher();
    if (
      cipher === null ||
      cipher === undefined ||
      typeof cipher.decrypt !== "function" ||
      typeof cipher.encrypt !== "function"
    ) {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
    }
    return cipher;
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
