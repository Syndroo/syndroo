/**
 * Portable publisher preparation.
 *
 * One asynchronous function reads the credential slot, decrypts an active
 * payload with trusted slot identity, and hands the result to the injected pure
 * strategy. The same returned `status` serves auth reads, admission and
 * execution, and the whole read is side-effect free: no platform request, no
 * token refresh, no storage mutation and no key material beyond the one
 * decryption of the selected slot.
 *
 * Trusted inputs — the record identity, the slot revision and the payload
 * generation that participates in the envelope AAD — come from the storage
 * snapshot, never from the ciphertext or the caller.
 */

import { isPlatform, type Platform } from "@syndroo/core";

import type { CipherContext, EncryptedSlotSnapshot } from "../contracts/credentials.js";
import { InvalidContractInputError, isIsoInstant, type IsoInstant } from "../contracts/primitives.js";
import type { CredentialCipher } from "../ports/credential-cipher.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type {
  PlatformConfigView,
  PlatformStrategyRegistry,
  PublisherPreparation,
} from "../ports/publisher-strategy.js";
import { AuthUseCaseError } from "./auth-errors.js";

export interface PreparePublisherDependencies {
  readonly credentials: CredentialStore;
  /**
   * Lazy cipher lookup: an empty or tombstoned slot is prepared without ever
   * constructing a cipher, so an Env-only instance still reports status.
   */
  readonly getCipher: () => CredentialCipher;
  readonly strategies: PlatformStrategyRegistry;
  /** Plain instance configuration for one platform; never an `Env` object. */
  readonly configFor: (platform: Platform) => PlatformConfigView;
}

/** Matches the frozen `PreparePublisher` signature used by create and execute. */
export type PreparePublisher = (platform: Platform, now: IsoInstant) => Promise<PublisherPreparation>;

/** Bind the dependencies once; the returned function is pure per call. */
export function createPreparePublisher(dependencies: PreparePublisherDependencies): PreparePublisher {
  return (platform: Platform, now: IsoInstant): Promise<PublisherPreparation> =>
    preparePublisher(platform, now, dependencies);
}

/**
 * Prepare one platform.
 *
 * Failure channels are deliberate:
 *
 * - a storage read failure or an unusable record identity is a controlled
 *   error, because an absent slot must never be inferred from a failed read;
 * - a cipher, key or payload failure on a *selected* active slot is not an
 *   error: the strategy is called with `plaintext: null` and reports its own
 *   blocked status for that slot, so Env user credentials are never selected.
 */
export async function preparePublisher(
  platform: Platform,
  now: IsoInstant,
  dependencies: PreparePublisherDependencies,
): Promise<PublisherPreparation> {
  if (!isPlatform(platform)) {
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
  if (!isIsoInstant(now)) {
    // Wiring error, not caller input: the caller supplies an already
    // normalized observation instant.
    throw new InvalidContractInputError("preparation requires a canonical UTC observation instant");
  }
  const strategy = resolveStrategy(platform, dependencies);
  const slot = await readTrustedSlot(platform, dependencies);
  const plaintext = await readActivePlaintext(slot, dependencies);
  const config = readConfig(platform, dependencies);
  try {
    return strategy.prepare({ platform, slot, plaintext, config, now });
  } catch {
    // An injected strategy failure is reported as a controlled, message-free
    // failure instead of escaping with its own text or cause.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "unavailable");
  }
}

function resolveStrategy(
  platform: Platform,
  dependencies: PreparePublisherDependencies,
): ReturnType<PlatformStrategyRegistry["strategyFor"]> {
  try {
    return dependencies.strategies.strategyFor(platform);
  } catch {
    // Known-but-uninstalled platforms keep their existing controlled response.
    throw new AuthUseCaseError("INVALID_REQUEST", "platform");
  }
}

/**
 * Read the slot and validate only the identity a trusted context depends on.
 *
 * Value-level problems inside a record (an invalid internal date, an expired
 * credential, a malformed payload, a refresh lease) stay the pure strategy's
 * business: they produce a blocked *status*, which is what an auth read needs.
 * What is checked here is that the record belongs to this platform, that its
 * status is one of the three known states and that its revisions are sane,
 * because those values select the AAD context and the reported revision.
 */
export async function readTrustedSlot(
  platform: Platform,
  dependencies: Pick<PreparePublisherDependencies, "credentials">,
): Promise<EncryptedSlotSnapshot> {
  let snapshot: unknown;
  try {
    snapshot = await dependencies.credentials.readSlot({ platform });
  } catch {
    // A storage failure is never an absent slot: it cannot become revision 0 or
    // an Env fallback.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "store_unavailable");
  }
  if (!isTrustedSlotSnapshot(snapshot, platform)) {
    // A malformed record — including metadata whose getter throws — is reported
    // as one fixed failure and never as a guessed revision.
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "corrupt_record");
  }
  return snapshot;
}

/**
 * Validate exactly the identity the trusted context depends on.
 *
 * Every read is guarded: an injected store may return a hostile object whose
 * getters throw, and that must not become the caller's error.
 */
function isTrustedSlotSnapshot(value: unknown, platform: Platform): value is EncryptedSlotSnapshot {
  try {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const snapshot = value as Record<string, unknown>;
    if (snapshot["platform"] !== platform) {
      return false;
    }
    const revision = snapshot["revision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      return false;
    }
    const status = snapshot["status"];
    return status === "empty" || status === "active" || status === "tombstone";
  } catch {
    return false;
  }
}

/**
 * Decrypt the selected active payload, or return null.

 * Null is the documented "unreadable selected group" signal: the strategy then
 * reports a blocked status for this slot and the caller never falls back to
 * another Env account. An absent or tombstoned slot returns null without
 * touching the cipher at all.
 */
async function readActivePlaintext(
  slot: EncryptedSlotSnapshot,
  dependencies: PreparePublisherDependencies,
): Promise<Uint8Array | null> {
  let context: CipherContext | null;
  let envelope: EncryptedSlotSnapshot["envelope"];
  try {
    if (slot.status !== "active") {
      return null;
    }
    context = activeSlotContext(slot);
    envelope = slot.envelope;
  } catch {
    // Hostile snapshot metadata is treated as an unreadable selected group.
    return null;
  }
  if (context === null || envelope === null) {
    return null;
  }
  try {
    const cipher = dependencies.getCipher();
    if (cipher === null || cipher === undefined || typeof cipher.decrypt !== "function") {
      return null;
    }
    const decrypted = await cipher.decrypt(envelope, context);
    if (!(decrypted instanceof Uint8Array) || decrypted.byteLength === 0) {
      return null;
    }
    // Copy: a cipher may reuse the buffer it returned.
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}

/**
 * Trusted AAD context of an active payload, or null when the record cannot
 * describe one. `recordId` is the fixed runtime convention (`platform`), and
 * the payload generation comes from the storage snapshot.
 */
export function activeSlotContext(slot: EncryptedSlotSnapshot): CipherContext | null {
  try {
    if (slot.status !== "active" || slot.envelope === null) {
      return null;
    }
    if (slot.payloadSchemaVersion !== 1) {
      return null;
    }
    const payloadRevision = slot.payloadRevision;
    if (
      typeof payloadRevision !== "number" ||
      !Number.isSafeInteger(payloadRevision) ||
      payloadRevision < 0
    ) {
      return null;
    }
    return Object.freeze({
      purpose: "active_slot" as const,
      // Runtime convention: an active slot's trusted record id is the platform
      // value (the credential table's primary key), not the purpose name.
      recordId: slot.platform,
      platform: slot.platform,
      payloadSchemaVersion: 1,
      payloadRevision,
    });
  } catch {
    return null;
  }
}

function readConfig(
  platform: Platform,
  dependencies: PreparePublisherDependencies,
): PlatformConfigView {
  try {
    return dependencies.configFor(platform);
  } catch {
    throw new AuthUseCaseError("STORE_UNAVAILABLE", "unavailable");
  }
}
