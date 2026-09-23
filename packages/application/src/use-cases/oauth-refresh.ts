/**
 * Portable OAuth credential refresh.
 *
 * Order is part of the contract:
 *
 * 1. Snapshot the caller's intent synchronously and read the slot once.
 * 2. Preflight entirely before any lease or network work: an active slot with a
 *    readable native payload that the narrow driver can actually refresh, no
 *    reconnect state, no held or expired lease, a matching revision and a safe
 *    next payload generation.
 * 3. Acquire exactly one 60-second lease with the observed revision. An unknown,
 *    throwing or conflicting acquisition performs zero external calls.
 * 4. Validate the acquired snapshot, lease token, platform and revision identity
 *    against the slot the preflight used; the winner alone owns the exchange.
 * 5. Send exactly one exchange, then encrypt the returned payload with the
 *    active-slot AAD and commit with the exact lease and revision.
 * 6. Every uncertain, failed or malformed external result records
 *    `reconnect_required` fenced to the same lease and revision. The token is
 *    never freed for a second exchange, and a lost commit acknowledgement is
 *    reported as a controlled failure rather than a fresh success.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import type {
  CipherContext,
  EncryptedCredential,
  EncryptedSlotSnapshot,
  RefreshLease,
  RefreshState,
} from "../contracts/credentials.js";
import {
  InvalidContractInputError,
  REFRESH_LEASE_MS,
  compareInstants,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { AuthMutationReceipt, SafeTarget } from "../contracts/status.js";
import { assertEncryptedEnvelopeShape, type CredentialCipher } from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { PlatformConfigView, PlatformStrategyRegistry } from "../ports/publisher-strategy.js";
import { AuthUseCaseError, authFailure } from "./auth-errors.js";
import { nextPayloadRevision, projectStatus } from "./direct-credentials.js";
import { preserveDriverFailure } from "./oauth-driver.js";
import {
  requireRefreshDriverSnapshot,
  type OAuthRefreshDriver,
  type OAuthRefreshDriverResolver,
} from "./oauth-refresh-driver.js";
import { readTrustedSlot } from "./prepare-publisher.js";
import { readClockNow, type UseCaseClock } from "./shared.js";

/** Schema generation of the native active-slot credential payload. */
export const ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION = 1;

/** Cipher plaintext bound for a refreshed native payload. */
export const MAX_REFRESHED_PLAINTEXT_BYTES = 64 * 1024;

export interface RefreshOAuthCredentialInput {
  readonly platform: Platform;
  /** Operator-observed slot revision, or null/absent for compatibility. */
  readonly expectedRevision?: number | null;
}

export interface RefreshOAuthCredentialDependencies {
  readonly credentials: CredentialStore;
  /** Write cipher, resolved before the lease is taken. */
  readonly getCipher: () => CredentialCipher;
  readonly drivers: OAuthRefreshDriverResolver;
  readonly strategies: PlatformStrategyRegistry;
  readonly configFor: (platform: Platform) => PlatformConfigView;
  readonly clock: UseCaseClock;
  /** New opaque lease token; called at most once per attempt. */
  readonly leaseTokens: () => string;
}

interface SlotView {
  readonly platform: Platform;
  readonly status: "empty" | "active" | "tombstone";
  readonly revision: number;
  readonly bindingId: string | null;
  readonly envelope: EncryptedCredential | null;
  readonly payloadRevision: number | null;
  readonly payloadSchemaVersion: number | null;
  readonly expiresAt: IsoInstant | null;
  readonly target: SafeTarget | null;
  readonly refreshLease: RefreshLease | null;
  readonly refreshState: RefreshState;
}

interface RefreshPlan {
  readonly platform: Platform;
  readonly expectedRevision: number | null;
}

export async function refreshOAuthCredential(
  input: RefreshOAuthCredentialInput,
  dependencies: RefreshOAuthCredentialDependencies,
): Promise<AuthMutationReceipt> {
  // Snapshot the caller's intent before the first await.
  let plan: RefreshPlan;
  try {
    plan = snapshotInput(input);
  } catch (error) {
    throw authFailure(error, "INVALID_REQUEST", "platform");
  }

  const slot = await readTrustedSlot(plan.platform, dependencies);
  const view = snapshotSlot(slot, plan.platform);
  const observedRevision = plan.expectedRevision ?? view.revision;
  if (observedRevision !== view.revision) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
  }
  if (view.status !== "active" || view.bindingId === null) {
    // An absent or tombstoned slot has nothing to refresh; Env configuration is
    // never a refresh source.
    throw new AuthUseCaseError("AUTH_CONFLICT", "no_refresh_payload");
  }
  if (view.refreshState === "reconnect_required") {
    throw new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
  }
  const preflightTime = readClockNow(dependencies.clock);
  if (view.refreshLease !== null) {
    const leaseExpiry = view.refreshLease.expiresAt;
    if (!isIsoInstant(leaseExpiry)) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    // A live lease means another winner is working; an expired unresolved lease
    // means the previous exchange result is unknown, so the token is never
    // reacquired automatically.
    throw compareInstants(preflightTime, leaseExpiry) < 0
      ? new AuthUseCaseError("AUTH_IN_PROGRESS", "lease_held")
      : new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
  }

  // The write cipher and the generation are fixed before any lease or network.
  const cipher = requireUsableCipher(dependencies);
  const nativePayload = await openActivePayload(view, plan.platform, cipher);
  const driver = await resolveRefreshDriver(plan.platform, dependencies);
  if (!canRefresh(driver, nativePayload)) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "no_refresh_payload");
  }
  const payloadRevision = nextPayloadRevision(slot);
  const leaseToken = requireLeaseToken(dependencies);

  const acquiredAt = readClockNow(dependencies.clock);
  const acquired = await acquireLease(
    plan.platform,
    view.revision,
    leaseToken,
    acquiredAt,
    dependencies,
  );
  const lease = requireAcquiredLease(acquired.lease, leaseToken, view.revision, acquiredAt);
  requireAcquiredSnapshot(acquired.snapshot, view, plan.platform, lease);

  const exchangeTime = readClockNow(dependencies.clock);
  if (compareInstants(exchangeTime, lease.expiresAt) >= 0) {
    // The safety window elapsed before the exchange: the token is never used.
    await recordReconnect(plan.platform, leaseToken, view.revision, "unknown_result", dependencies);
    throw new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
  }

  const attempt = await attemptRefresh(driver, nativePayload, exchangeTime);
  if (attempt.kind === "failure") {
    await recordReconnect(
      plan.platform,
      leaseToken,
      view.revision,
      attempt.failureReason,
      dependencies,
    );
    throw attempt.error;
  }
  let refreshed: { readonly plaintext: Uint8Array; readonly expiresAt: IsoInstant | null };
  try {
    refreshed = requireRefreshResult(attempt.value);
  } catch (error) {
    await recordReconnect(plan.platform, leaseToken, view.revision, "invalid_response", dependencies);
    throw authFailure(error, "PROVIDER_ERROR", "invalid_driver_response");
  }

  let envelope: EncryptedCredential;
  try {
    envelope = await encryptActivePayload(
      cipher,
      plan.platform,
      refreshed.plaintext,
      payloadRevision,
    );
  } catch (error) {
    // A new token that cannot be stored leaves the connection state unknown, so
    // the same lease records reconnect_required before the fixed error.
    await recordReconnect(plan.platform, leaseToken, view.revision, "unknown_result", dependencies);
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }

  // The commit time is read *after* the awaited encryption: a slow or hostile
  // cipher that pushes past the safety window must not produce a commit.
  const completionTime = readClockNow(dependencies.clock);
  if (compareInstants(completionTime, lease.expiresAt) >= 0) {
    await recordReconnect(plan.platform, leaseToken, view.revision, "unknown_result", dependencies);
    throw new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
  }

  const committed = await commitRefresh(
    plan.platform,
    leaseToken,
    view.revision,
    completionTime,
    envelope,
    payloadRevision,
    refreshed.expiresAt,
    view.target,
    dependencies,
  );
  if (committed.kind === "thrown") {
    // The commit may already have applied. Attempt the fenced failure record
    // first — a conflict means the row moved, so a committed new revision is
    // left untouched — then report the ambiguity: never a success and never an
    // automatic retry. The operator inspects status and reconnects explicitly
    // if the grant is uncertain.
    await recordReconnect(plan.platform, leaseToken, view.revision, "unknown_result", dependencies);
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  const commit = committed.value;
  if (commit.kind === "conflict") {
    if (commit.reason === "reconnect_required") {
      await recordReconnect(plan.platform, leaseToken, view.revision, "unknown_result", dependencies);
      throw new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
    }
    throw commitConflict(commit.reason);
  }
  if (commit.kind !== "applied" && commit.kind !== "already_applied") {
    // An arbitrary store answer is never a successful refresh.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "unexpected_result");
  }

  // The receipt describes the snapshot this commit proposed: binding id and
  // target are preserved, the lease is cleared and the generation advanced.
  const proposed = proposedRefreshedSlot(
    plan.platform,
    view.revision + 1,
    view.bindingId,
    envelope,
    payloadRevision,
    refreshed.expiresAt,
    view.target,
    completionTime,
  );
  const status = projectStatus(
    plan.platform,
    proposed,
    refreshed.plaintext,
    completionTime,
    dependencies,
  );
  return Object.freeze({
    platform: plan.platform,
    action: "refreshed" as const,
    revision: view.revision + 1,
    configured: status.configured === true,
    readiness: status.readiness,
    expiresAt: refreshed.expiresAt,
  });
}

function snapshotInput(input: unknown): RefreshPlan {
  const record = asRecord(input);
  if (record === null || !isPlatform(record["platform"])) {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
  const expectedRevision = record["expectedRevision"];
  if (expectedRevision !== undefined && expectedRevision !== null) {
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      throw new AuthUseCaseError("INVALID_REQUEST", "expected_revision");
    }
    return Object.freeze({ platform: record["platform"], expectedRevision });
  }
  return Object.freeze({ platform: record["platform"], expectedRevision: null });
}

/** Snapshot the slot fields this use case uses, in one guarded read. */
function snapshotSlot(slot: EncryptedSlotSnapshot, platform: Platform): SlotView {
  try {
    const status = slot.status;
    const revision = slot.revision;
    const payloadRevision = slot.payloadRevision;
    const payloadSchemaVersion = slot.payloadSchemaVersion;
    if (status !== "empty" && status !== "active" && status !== "tombstone") {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    if (
      payloadRevision !== null &&
      (typeof payloadRevision !== "number" || !Number.isSafeInteger(payloadRevision))
    ) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    if (
      payloadSchemaVersion !== null &&
      (typeof payloadSchemaVersion !== "number" || !Number.isSafeInteger(payloadSchemaVersion))
    ) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    const refreshState = slot.refreshState;
    if (refreshState !== "ready" && refreshState !== "reconnect_required") {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    // Nested metadata is copied by value now, so every later comparison is
    // against this snapshot instead of a mutable store reference.
    return Object.freeze({
      platform,
      status,
      revision,
      bindingId: slot.bindingId,
      envelope: copyEnvelope(slot.envelope),
      payloadRevision,
      payloadSchemaVersion,
      expiresAt: slot.expiresAt,
      target: copyTarget(slot.target),
      refreshLease: copyLease(slot.refreshLease),
      refreshState,
    });
  } catch (error) {
    throw authFailure(error, "STORE_UNAVAILABLE", "corrupt_record");
  }
}

function copyEnvelope(value: EncryptedCredential | null): EncryptedCredential | null {
  if (value === null) {
    return null;
  }
  return Object.freeze({
    version: value.version,
    algorithm: value.algorithm,
    keyId: value.keyId,
    iv: value.iv,
    ciphertext: value.ciphertext,
  });
}

function copyTarget(value: SafeTarget | null): SafeTarget | null {
  if (value === null) {
    return null;
  }
  return Object.freeze({ label: value.label, source: value.source });
}

function copyLease(value: RefreshLease | null): RefreshLease | null {
  if (value === null) {
    return null;
  }
  return Object.freeze({
    token: value.token,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
    revision: value.revision,
  });
}

/** Decrypt the stored native payload under the active-slot AAD. */
async function openActivePayload(
  view: SlotView,
  platform: Platform,
  cipher: CredentialCipher,
): Promise<Uint8Array> {
  const envelope = view.envelope;
  if (
    envelope === null ||
    view.payloadSchemaVersion !== ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION ||
    view.payloadRevision === null
  ) {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  const context: CipherContext = Object.freeze({
    purpose: "active_slot" as const,
    recordId: platform,
    platform,
    payloadSchemaVersion: ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION,
    payloadRevision: view.payloadRevision,
  });
  assertEncryptedEnvelopeShape(envelope);
  try {
    const plaintext = await cipher.decrypt(envelope, context);
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    // Copy: a cipher may reuse the buffer it returned.
    return new Uint8Array(plaintext);
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "cipher_unavailable");
  }
}

async function resolveRefreshDriver(
  platform: Platform,
  dependencies: RefreshOAuthCredentialDependencies,
): Promise<OAuthRefreshDriver> {
  let resolved: OAuthRefreshDriver | null;
  try {
    resolved = await dependencies.drivers(platform);
  } catch {
    throw new AuthUseCaseError("INSTANCE_NOT_READY", "unavailable");
  }
  if (resolved === null || resolved === undefined) {
    throw new AuthUseCaseError("AUTH_CONFLICT", "no_refresh_payload");
  }
  return requireRefreshDriverSnapshot(resolved, platform);
}

/**
 * Synchronous preflight.
 *
 * A thenable answer is a contract violation: the driver must not perform
 * network work here. The rejection of such a value is disposed so a hostile
 * driver cannot leave an unhandled rejection behind.
 */
function canRefresh(driver: OAuthRefreshDriver, plaintext: Uint8Array): boolean {
  let result: unknown;
  try {
    result = driver.canRefresh(new Uint8Array(plaintext));
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "invalid_driver_response");
  }
  try {
    if (typeof result === "object" && result !== null) {
      if (typeof (result as { readonly then?: unknown }).then === "function") {
        disposeRejection(result);
        throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
      }
    }
    if (typeof result !== "boolean") {
      throw new AuthUseCaseError("INSTANCE_NOT_READY", "invalid_driver_response");
    }
    return result;
  } catch (error) {
    throw authFailure(error, "INSTANCE_NOT_READY", "invalid_driver_response");
  }
}

function disposeRejection(value: unknown): void {
  try {
    void Promise.resolve(value as PromiseLike<unknown>).catch(() => undefined);
  } catch {
    // A thenable whose `then` throws is already reported as a fixed violation.
  }
}

/**
 * Acquire exactly one lease.
 *
 * An unknown, throwing or conflicting acquisition performs zero external calls.
 */
async function acquireLease(
  platform: Platform,
  expectedRevision: number,
  leaseToken: string,
  now: IsoInstant,
  dependencies: RefreshOAuthCredentialDependencies,
): Promise<{
  readonly snapshot: EncryptedSlotSnapshot;
  readonly lease: RefreshLease;
}> {
  let result: Awaited<ReturnType<CredentialStore["acquireRefresh"]>>;
  try {
    result = await dependencies.credentials.acquireRefresh({
      platform,
      expectedRevision,
      leaseToken,
      now,
      leaseDurationMs: REFRESH_LEASE_MS,
    });
  } catch {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  if (result.kind === "acquired") {
    return { snapshot: result.snapshot, lease: result.lease };
  }
  if (result.kind === "unknown") {
    // The lease write result is unknown: no winner is proven and no exchange
    // may start.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  throw leaseConflict(result.reason);
}

function leaseConflict(reason: string): AuthUseCaseError {
  switch (reason) {
    case "revision_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
    case "lease_held":
      return new AuthUseCaseError("AUTH_IN_PROGRESS", "lease_held");
    case "reconnect_required":
      return new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
    default:
      // not_found, tombstone and no_refresh_payload all mean "nothing to
      // refresh" from this connection's point of view.
      return new AuthUseCaseError("AUTH_CONFLICT", "no_refresh_payload");
  }
}

function requireLeaseToken(dependencies: RefreshOAuthCredentialDependencies): string {
  const value = dependencies.leaseTokens();
  if (!isOpaqueId(value)) {
    // Wiring defect: the injected factory must produce a bounded opaque id.
    throw new InvalidContractInputError(
      "lease token factory must return a bounded opaque identifier",
    );
  }
  return value;
}

/** Validate the acquired lease identity before any exchange. */
function requireAcquiredLease(
  lease: RefreshLease,
  leaseToken: string,
  revision: number,
  acquiredAt: IsoInstant,
): RefreshLease {
  try {
    const expectedExpiry = new Date(Date.parse(acquiredAt) + REFRESH_LEASE_MS).toISOString();
    if (
      lease.token !== leaseToken ||
      lease.revision !== revision ||
      // The returned lease must be exactly the one requested: our acquisition
      // instant and the requested 60-second safety window, not merely a later
      // expiry than the start.
      lease.acquiredAt !== acquiredAt ||
      !isIsoInstant(lease.expiresAt) ||
      lease.expiresAt !== expectedExpiry
    ) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
    return Object.freeze({
      token: lease.token,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      revision: lease.revision,
    });
  } catch (error) {
    throw authFailure(error, "STORE_UNAVAILABLE", "corrupt_record");
  }
}

/**
 * The acquired snapshot must describe the exact connection the preflight read:
 * same platform, revision, binding id, envelope and payload generation.
 */
function requireAcquiredSnapshot(
  snapshot: EncryptedSlotSnapshot,
  view: SlotView,
  platform: Platform,
  lease: RefreshLease,
): void {
  try {
    const embeddedLease = copyLease(snapshot.refreshLease);
    if (
      snapshot.platform !== platform ||
      snapshot.status !== "active" ||
      snapshot.revision !== view.revision ||
      snapshot.bindingId !== view.bindingId ||
      snapshot.payloadRevision !== view.payloadRevision ||
      snapshot.payloadSchemaVersion !== view.payloadSchemaVersion ||
      !sameEnvelope(copyEnvelope(snapshot.envelope), view.envelope) ||
      // The acquired snapshot must describe the same connection the preflight
      // read: identical target, expiry and refresh state, with its embedded
      // lease equal to the lease that was returned to us.
      snapshot.expiresAt !== view.expiresAt ||
      snapshot.refreshState !== view.refreshState ||
      !sameTarget(copyTarget(snapshot.target), view.target) ||
      embeddedLease === null ||
      embeddedLease.token !== lease.token ||
      embeddedLease.acquiredAt !== lease.acquiredAt ||
      embeddedLease.expiresAt !== lease.expiresAt ||
      embeddedLease.revision !== lease.revision
    ) {
      throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
    }
  } catch (error) {
    throw authFailure(error, "STORE_UNAVAILABLE", "corrupt_record");
  }
}

/**
 * Compare two envelopes by value.
 *
 * A real storage adapter rebuilds the record, so reference equality would be
 * wrong; the ciphertext identity is what must match.
 */
function sameEnvelope(
  left: EncryptedCredential | null,
  right: EncryptedCredential | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.version === right.version &&
    left.algorithm === right.algorithm &&
    left.keyId === right.keyId &&
    left.iv === right.iv &&
    left.ciphertext === right.ciphertext
  );
}

function sameTarget(left: SafeTarget | null, right: SafeTarget | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.label === right.label && left.source === right.source;
}

type RefreshAttempt =
  | { readonly kind: "result"; readonly value: unknown }
  | {
      readonly kind: "failure";
      readonly error: AuthUseCaseError;
      readonly failureReason: "unknown_result" | "provider_rejected" | "invalid_response";
    };

/** One exchange attempt; a provider failure is fixed and never retried. */
async function attemptRefresh(
  driver: OAuthRefreshDriver,
  plaintext: Uint8Array,
  now: IsoInstant,
): Promise<RefreshAttempt> {
  try {
    return {
      kind: "result",
      value: await driver.refresh({ plaintext: new Uint8Array(plaintext), now }),
    };
  } catch (error) {
    const reason = preserveDriverFailure(error);
    return {
      kind: "failure",
      error: new AuthUseCaseError("PROVIDER_ERROR", "provider_error"),
      failureReason:
        reason === "denied"
          ? "provider_rejected"
          : reason === "invalid_response"
            ? "invalid_response"
            : "unknown_result",
    };
  }
}

/** Validate one exchange result; buffers are copied and the expiry is canonical. */
function requireRefreshResult(value: unknown): {
  readonly plaintext: Uint8Array;
  readonly expiresAt: IsoInstant | null;
} {
  try {
    const record = asRecord(value);
    if (record === null) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    const plaintext = record["plaintext"];
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    if (plaintext.byteLength > MAX_REFRESHED_PLAINTEXT_BYTES) {
      // The cipher refuses a larger decoded payload, so it is rejected before
      // any encryption attempt.
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    const expiresAt = record["expiresAt"];
    if (expiresAt !== null && !isIsoInstant(expiresAt)) {
      throw new AuthUseCaseError("PROVIDER_ERROR", "invalid_driver_response");
    }
    return Object.freeze({
      plaintext: new Uint8Array(plaintext),
      expiresAt,
    });
  } catch (error) {
    throw authFailure(error, "PROVIDER_ERROR", "invalid_driver_response");
  }
}

async function encryptActivePayload(
  cipher: CredentialCipher,
  platform: Platform,
  plaintext: Uint8Array,
  payloadRevision: number,
): Promise<EncryptedCredential> {
  const context: CipherContext = Object.freeze({
    purpose: "active_slot" as const,
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

/**
 * Commit with the exact lease and revision.

 * A thrown failure is reported as a controlled storage failure and is never
 * retried: the commit may already have applied, and a later explicit refresh is
 * the only recovery path.
 */
async function commitRefresh(
  platform: Platform,
  leaseToken: string,
  expectedRevision: number,
  now: IsoInstant,
  envelope: EncryptedCredential,
  payloadRevision: number,
  expiresAt: IsoInstant | null,
  target: SafeTarget | null,
  dependencies: RefreshOAuthCredentialDependencies,
): Promise<
  | { readonly kind: "result"; readonly value: Awaited<ReturnType<CredentialStore["completeRefresh"]>> }
  | { readonly kind: "thrown" }
> {
  try {
    return {
      kind: "result",
      value: await dependencies.credentials.completeRefresh({
        platform,
        leaseToken,
        expectedRevision,
        now,
        envelope,
        payloadRevision,
        payloadSchemaVersion: ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION,
        expiresAt,
        // Binding id and target are preserved: a refresh never retargets or
        // rebinds the connection.
        target,
      }),
    };
  } catch {
    return { kind: "thrown" };
  }
}

function commitConflict(reason: string): AuthUseCaseError {
  switch (reason) {
    case "revision_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "revision_mismatch");
    case "lease_mismatch":
      return new AuthUseCaseError("AUTH_CONFLICT", "lease_mismatch");
    case "reconnect_required":
      return new AuthUseCaseError("AUTH_CONFLICT", "reconnect_required");
    case "not_found":
    case "terminal":
      return new AuthUseCaseError("AUTH_CONFLICT", "no_refresh_payload");
    default:
      return new AuthUseCaseError("AUTH_CONFLICT", "unexpected_result");
  }
}

/**
 * Record `reconnect_required` for the lease that actually failed.
 *
 * The observation time is read inside this function so a caller's earlier
 * timestamp can never be used to write a stale failure. A conflict means the
 * row moved under us (for example a set/remove/complete won) and nothing is
 * implied; a thrown storage failure is a controlled error.
 */
async function recordReconnect(
  platform: Platform,
  leaseToken: string,
  expectedRevision: number,
  reason: "unknown_result" | "provider_rejected" | "invalid_response",
  dependencies: RefreshOAuthCredentialDependencies,
): Promise<boolean> {
  try {
    const now = readClockNow(dependencies.clock);
    const result: Awaited<ReturnType<CredentialStore["markReconnectRequired"]>> =
      await dependencies.credentials.markReconnectRequired({
        platform,
        leaseToken,
        expectedRevision,
        now,
        reason,
      });
    // Only a documented success counts as recorded; a conflict means the row
    // moved under us and any other answer is not a recorded failure.
    return result.kind === "applied" || result.kind === "already_applied";
  } catch {
    // A failure record that cannot be written never becomes a success: the
    // caller's primary fixed error is reported instead.
    return false;
  }
}

/** The active snapshot this commit proposes, used only for the receipt. */
function proposedRefreshedSlot(
  platform: Platform,
  revision: number,
  bindingId: string,
  envelope: EncryptedCredential,
  payloadRevision: number,
  expiresAt: IsoInstant | null,
  target: SafeTarget | null,
  now: IsoInstant,
): EncryptedSlotSnapshot {
  return Object.freeze({
    platform,
    status: "active" as const,
    revision,
    bindingId,
    envelope,
    payloadRevision,
    payloadSchemaVersion: ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION,
    expiresAt,
    target,
    refreshLease: null,
    refreshState: "ready" as const,
    lastRefreshCommitFingerprint: null,
    updatedAt: now,
  });
}

function requireUsableCipher(
  dependencies: RefreshOAuthCredentialDependencies,
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
