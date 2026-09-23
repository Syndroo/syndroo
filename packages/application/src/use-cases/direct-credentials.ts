/**
 * Portable direct credential set and remove.
 *
 * Both use cases are portable on purpose: the platform body decoder, the
 * cipher, the strategy registry and the instance configuration are injected, so
 * no provider package, Cloudflare binding or `Env` object enters application
 * code.
 *
 * Set order (the snapshot precedes the first await on purpose):
 *
 * 1. Snapshot the caller's intent, decode the body and copy the bytes plus safe
 *    metadata synchronously. A caller mutating its own object, its buffer or the
 *    decoder's result afterwards cannot change what is encrypted or reported.
 * 2. Read the current slot. A failed read is a controlled failure, never an
 *    inferred revision 0.
 * 3. Check the operator's observed revision. A mismatch performs zero
 *    encryption and zero writes.
 * 4. Compute the next payload generation as
 *    `max(payloadRevision ?? 0, revision) + 1` with an overflow check.
 * 5. Create one new opaque connection id.
 * 6. Encrypt once with the active-slot context.
 * 7. Issue exactly one compare-and-set. A conflict, a thrown failure or a lost
 *    acknowledgement is never retried: the store may already have committed.
 * 8. Derive the readiness projection from the committed snapshot and the
 *    already-decoded plaintext, never from a second read that could observe a
 *    different winner.
 *
 * Remove never needs the cipher, a binding signer or the payload plaintext: with
 * an explicit revision it fences the slot directly, and the compatibility path
 * without a revision reads the slot once before the same guarded write.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import type {
  CipherContext,
  EncryptedCredential,
  EncryptedSlotSnapshot,
  SlotChange,
  SlotMutation,
  SlotMutationResult,
} from "../contracts/credentials.js";
import {
  InvalidContractInputError,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { AuthMutationReceipt, Readiness, SafeTarget } from "../contracts/status.js";
import {
  assertEncryptedEnvelopeShape,
  type CredentialCipher,
} from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { PlatformConfigView, PlatformStrategyRegistry } from "../ports/publisher-strategy.js";
import { AuthUseCaseError, authFailure, safeReadiness } from "./auth-errors.js";
import { readTrustedSlot } from "./prepare-publisher.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

/** Structural result of the injected per-platform direct decoder. */
export interface DirectCredentialDecode {
  readonly plaintext: Uint8Array;
  readonly payloadSchemaVersion: 1;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
}

/**
 * Injected direct decoder. It owns platform field validation and rejects
 * unknown fields; control fields such as `expectedRevision` never belong inside
 * the credential body it receives.
 */
export type DirectCredentialDecoder = (
  platform: Platform,
  input: unknown,
) => DirectCredentialDecode;

export interface DirectCredentialDependencies {
  readonly credentials: CredentialStore;
  /**
   * Lazy cipher lookup. Remove never calls it, so a removal stays possible when
   * the credential key is missing or the runtime has no cipher wired.
   */
  readonly getCipher: () => CredentialCipher;
  readonly strategies: PlatformStrategyRegistry;
  readonly configFor: (platform: Platform) => PlatformConfigView;
  readonly clock: UseCaseClock;
  /** New connection identity; called exactly once per successful set. */
  readonly bindingIds: () => string;
  readonly decodeDirectCredential: DirectCredentialDecoder;
}

export interface SetDirectCredentialInput {
  readonly platform: Platform;
  /** Raw credential body; it never carries a control field. */
  readonly credential: unknown;
  /** Operator-observed slot revision, or null/absent for compatibility. */
  readonly expectedRevision?: number | null;
}

export interface RemoveCredentialInput {
  readonly platform: Platform;
  /** Operator-observed slot revision; absent means "read once, then guard". */
  readonly expectedRevision?: number | null;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_TARGET_LABEL_LENGTH = 256;

interface PreparedDirectWrite {
  readonly plaintext: Uint8Array;
  readonly payloadSchemaVersion: 1;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
}

/**
 * Store one complete user group as the active credential.
 *
 * A complete user group is storable even when runtime app or target
 * configuration is missing: the receipt then reports that readiness instead of
 * rejecting an otherwise complete group.
 */
export async function setDirectCredential(
  input: SetDirectCredentialInput,
  dependencies: DirectCredentialDependencies,
): Promise<AuthMutationReceipt> {
  let platform: Platform;
  let expectedRevision: number | null;
  let prepared: PreparedDirectWrite;
  try {
    platform = requirePlatform(input);
    requireInstalledStrategy(platform, dependencies);
    expectedRevision = requireOptionalRevision(input);
    prepared = decodeDirectWrite(platform, requireCredentialBody(input), dependencies);
  } catch (error) {
    throw authFailure(error, "INVALID_REQUEST", "credential_body");
  }
  const now = readClockNow(dependencies.clock);

  const slot = await readTrustedSlot(platform, dependencies);
  const observedRevision = expectedRevision ?? slot.revision;
  if (observedRevision !== slot.revision) {
    // Guard failure: nothing was encrypted and nothing was written.
    throw new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
  }

  const payloadRevision = nextPayloadRevision(slot);
  const bindingId = createBindingId(dependencies);
  const envelope = await encryptActiveSlot(platform, prepared, payloadRevision, dependencies);
  const change: Extract<SlotChange, { kind: "set" }> = {
    kind: "set",
    bindingId,
    envelope,
    payloadRevision,
    payloadSchemaVersion: prepared.payloadSchemaVersion,
    expiresAt: prepared.expiresAt,
    target: prepared.target,
  };
  const result = await compareAndSetSlot(platform, observedRevision, change, now, dependencies);
  if (result.kind !== "applied") {
    throw conflictFailure(result);
  }

  const revision = requireAppliedRevision(result, observedRevision);
  const committed = committedActiveSlot(slot, revision, change, now);
  const status = projectStatus(platform, committed, prepared.plaintext, now, dependencies);
  return Object.freeze({
    platform,
    action: "stored" as const,
    revision,
    configured: status.configured,
    readiness: status.readiness,
  });
}

/**
 * Remove the active credential and leave a revisioned tombstone.
 *
 * With an explicit revision this performs no read, no decryption and no key
 * lookup, so an unreadable payload can still be fenced and cleared. Without a
 * revision it reads the slot once and uses that revision as the guard; it never
 * guesses revision zero and never deletes without a guard.
 */
export async function removeDirectCredential(
  input: RemoveCredentialInput,
  dependencies: DirectCredentialDependencies,
): Promise<AuthMutationReceipt> {
  let platform: Platform;
  let expectedRevision: number | null;
  try {
    platform = requirePlatform(input);
    expectedRevision = requireOptionalRevision(input);
  } catch (error) {
    throw authFailure(error, "INVALID_REQUEST", "expected_revision");
  }
  const now = readClockNow(dependencies.clock);

  let guardedRevision = expectedRevision;
  if (guardedRevision === null) {
    const slot = await readTrustedSlot(platform, dependencies);
    guardedRevision = slot.revision;
  }
  if (guardedRevision === Number.MAX_SAFE_INTEGER) {
    // A satisfied removal has to persist `revision + 1`, which is not a safe
    // integer. Nothing is read (for an explicit revision), encrypted or written.
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "payload_generation_overflow");
  }

  const result = await compareAndSetSlot(
    platform,
    guardedRevision,
    { kind: "remove" },
    now,
    dependencies,
  );
  if (result.kind !== "applied") {
    throw conflictFailure(result);
  }

  const revision = requireAppliedRevision(result, guardedRevision);
  // Readiness comes from the resulting tombstone plus the pure Env strategy, so
  // a correct Env configuration is still reported as ready after a removal.
  const tombstone = committedTombstone(platform, revision, now);
  const status = projectStatus(platform, tombstone, null, now, dependencies);
  return Object.freeze({
    platform,
    action: "removed" as const,
    revision,
    configured: status.configured,
    readiness: status.readiness,
  });
}

/**
 * Validate the revision a successful CAS reported before any receipt is built.
 *
 * A store that returns a non-safe or non-advancing revision has produced an
 * outcome this use case cannot describe, so it becomes one fixed storage
 * failure instead of a fabricated receipt.
 */
function requireAppliedRevision(
  result: { readonly revision: number },
  guardedRevision: number,
): number {
  try {
    const revision: unknown = result.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "unexpected_result");
    }
    if (revision <= guardedRevision) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "unexpected_result");
    }
    return revision;
  } catch (error) {
    throw authFailure(error, "STORE_UNAVAILABLE", "unexpected_result");
  }
}

function requirePlatform(input: unknown): Platform {
  const record = asRecord(input);
  const platform = record?.["platform"];
  if (!isPlatform(platform)) {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
  return platform;
}

/**
 * A direct set is only meaningful for an installed platform.
 *
 * Removal deliberately does not call this: an operator must always be able to
 * fence and clear a legacy slot, even for a platform this build no longer
 * installs.
 */
function requireInstalledStrategy(
  platform: Platform,
  dependencies: DirectCredentialDependencies,
): void {
  try {
    dependencies.strategies.strategyFor(platform);
  } catch {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
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

function requireCredentialBody(input: unknown): unknown {
  const record = asRecord(input);
  if (record === null) {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  return record["credential"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Decode the body and copy everything that will be encrypted or reported.
 *
 * A decoder failure — including a host that throws from a getter — becomes one
 * fixed request error; the decoder's own text, code and cause never travel.
 */
function decodeDirectWrite(
  platform: Platform,
  credential: unknown,
  dependencies: DirectCredentialDependencies,
): PreparedDirectWrite {
  let decoded: unknown;
  try {
    decoded = dependencies.decodeDirectCredential(platform, credential);
  } catch {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  const record = asRecord(decoded);
  if (record === null || record["payloadSchemaVersion"] !== 1) {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  const plaintext = record["plaintext"];
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  const expiresAt = record["expiresAt"];
  if (expiresAt !== null && !isIsoInstant(expiresAt)) {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  return Object.freeze({
    plaintext: new Uint8Array(plaintext),
    payloadSchemaVersion: 1 as const,
    expiresAt,
    target: readSafeTarget(record["target"]),
  });
}

/**
 * Validate the decoder's safe target metadata.
 *
 * Only a bounded, control-free label with a fixed provenance survives; an
 * unexpected value is a request error, never stored metadata.
 */
function readSafeTarget(value: unknown): SafeTarget | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  const label = record?.["label"];
  const source = record?.["source"];
  if (
    typeof label !== "string" ||
    label.trim() === "" ||
    label.length > MAX_TARGET_LABEL_LENGTH ||
    CONTROL_CHARACTER.test(label)
  ) {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  if (source !== "user" && source !== "provider") {
    throw new AuthUseCaseError("INVALID_REQUEST", "credential_body");
  }
  return Object.freeze({ label, source });
}

/**
 * Next encrypted payload generation, shared with the OAuth activation path.
 *
 * `max(payloadRevision ?? 0, revision) + 1` keeps the AAD generation ahead of
 * any earlier payload even after a delete/recreate, and the bound is checked
 * before any encryption happens.
 */
export function nextPayloadRevision(slot: EncryptedSlotSnapshot): number {
  let existing: unknown;
  let revision: unknown;
  try {
    existing = slot.payloadRevision;
    revision = slot.revision;
  } catch {
    // A store that returns hostile metadata is a corrupt record, never a
    // guessed generation.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  if (existing !== null && typeof existing !== "number") {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  if (existing !== null && (!Number.isSafeInteger(existing) || existing < 0)) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  const next = Math.max(existing ?? 0, revision) + 1;
  if (!Number.isSafeInteger(next)) {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "payload_generation_overflow");
  }
  return next;
}

function createBindingId(dependencies: DirectCredentialDependencies): string {
  const value = dependencies.bindingIds();
  if (!isOpaqueId(value)) {
    // Wiring defect: the injected factory must produce a bounded opaque id.
    throw new InvalidContractInputError("binding id factory must return a bounded opaque identifier");
  }
  return value;
}

async function encryptActiveSlot(
  platform: Platform,
  prepared: PreparedDirectWrite,
  payloadRevision: number,
  dependencies: DirectCredentialDependencies,
): Promise<EncryptedCredential> {
  const context: CipherContext = Object.freeze({
    purpose: "active_slot" as const,
    // Same trusted identity convention as preparation: the platform value is
    // the record id of an active credential slot.
    recordId: platform,
    platform,
    payloadSchemaVersion: prepared.payloadSchemaVersion,
    payloadRevision,
  });
  try {
    const cipher = dependencies.getCipher();
    if (cipher === null || cipher === undefined || typeof cipher.encrypt !== "function") {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "cipher_unavailable");
    }
    const envelope = await cipher.encrypt(prepared.plaintext, context);
    assertEncryptedEnvelopeShape(envelope);
    return envelope;
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

/**
 * Issue exactly one guarded slot write.
 *
 * A thrown failure is reported as a controlled storage failure and is never
 * retried: the store may have committed before losing its acknowledgement, and
 * a second write would produce a second revision.
 */
async function compareAndSetSlot(
  platform: Platform,
  expectedRevision: number,
  change: SlotChange,
  now: IsoInstant,
  dependencies: DirectCredentialDependencies,
): Promise<SlotMutationResult> {
  const mutation: SlotMutation = Object.freeze({ platform, expectedRevision, now, change });
  try {
    return await dependencies.credentials.compareAndSetSlot(mutation);
  } catch {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
}

/**
 * Map a non-applied CAS outcome.
 *
 * A direct set/remove has no replay identity, so an outcome other than
 * `applied` is reported as a conflict: the caller re-reads status instead of
 * receiving an invented receipt.
 */
function conflictFailure(result: SlotMutationResult): AuthUseCaseError {
  return result.kind === "conflict"
    ? new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch")
    : new AuthUseCaseError("AUTH_CONFLICT", "unexpected_result");
}

/**
 * Committed snapshot of a successful set.
 *
 * The documented `set` semantics replace the connection identity, target and
 * refresh metadata, so the projection cannot report the previous lease or
 * target.
 */
function committedActiveSlot(
  slot: EncryptedSlotSnapshot,
  revision: number,
  change: Extract<SlotChange, { kind: "set" }>,
  now: IsoInstant,
): EncryptedSlotSnapshot {
  return Object.freeze({
    platform: slot.platform,
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

/** Committed snapshot of a successful remove. */
function committedTombstone(
  platform: Platform,
  revision: number,
  now: IsoInstant,
): EncryptedSlotSnapshot {
  return Object.freeze({
    platform,
    status: "tombstone" as const,
    revision,
    bindingId: null,
    envelope: null,
    payloadRevision: null,
    payloadSchemaVersion: null,
    expiresAt: null,
    target: null,
    refreshLease: null,
    refreshState: "ready" as const,
    lastRefreshCommitFingerprint: null,
    updatedAt: now,
  });
}

/**
 * Readiness of one committed snapshot through the same pure strategy used for
 * status and admission, so a receipt never claims more than a status read does.
 *
 * The projection is defensive: a failing or misbehaving injected strategy or
 * configuration provider cannot fail a mutation that already committed, and it
 * cannot inject an arbitrary readiness value.
 */
export function projectStatus(
  platform: Platform,
  slot: EncryptedSlotSnapshot,
  plaintext: Uint8Array | null,
  now: IsoInstant,
  dependencies: Pick<DirectCredentialDependencies, "strategies" | "configFor">,
): { readonly configured: boolean; readonly readiness: Readiness } {
  try {
    const config = dependencies.configFor(platform);
    const preparation = dependencies.strategies.strategyFor(platform).prepare({
      platform,
      slot,
      plaintext,
      config,
      now,
    });
    const status =
      preparation.kind === "ready" ? preparation.prepared.status : preparation.status;
    return {
      configured: status.configured === true,
      readiness: safeReadiness(status.readiness),
    };
  } catch {
    return { configured: false, readiness: "unavailable" };
  }
}
