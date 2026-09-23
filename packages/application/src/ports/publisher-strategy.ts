/**
 * Platform strategy envelope.
 *
 * The application never imports a concrete provider package: the composition
 * root injects strategies whose credential types stay private to the strategy.
 * The application only receives a ready envelope carrying an immutable core
 * `Publisher` plus safe status, or a blocked envelope with a safe reason.
 */

import type { Platform, Publisher } from "@syndroo/core";

import type { BindingMaterial } from "../contracts/binding.js";
import type { EncryptedSlotSnapshot } from "../contracts/credentials.js";
import type { IsoInstant } from "../contracts/primitives.js";
import type { CredentialSource, Readiness, SafePlatformStatus, SafeTarget } from "../contracts/status.js";

export interface PlatformConfigView {
  readonly platform: Platform;
  /** Already-mapped instance configuration; never an Env object or binding. */
  readonly values: Readonly<Record<string, string>>;
  readonly publicUrl: string | null;
}

export type PublisherBlockReason =
  | "missing_credentials"
  | "needs_configuration"
  | "expired"
  | "reconnect_required"
  | "unavailable"
  | "invalid_configuration";

export interface PreparedPublisher {
  readonly platform: Platform;
  /** Immutable snapshot: the constructed Publisher is fixed for this attempt. */
  readonly publisher: Publisher;
  readonly status: SafePlatformStatus;
  readonly target: SafeTarget | null;
  /**
   * Credential slot metadata for connection identity. Never used as the
   * publication binding HMAC.
   */
  readonly slotBindingId: string | null;
  /**
   * Internal binding material for this connection. The application signs it
   * with the injected signer to obtain `credentialBinding`; it is never
   * exposed in a DTO, log event or archive object.
   */
  readonly bindingMaterial: BindingMaterial;
  readonly credentialRevision: number;
  readonly credentialSource: CredentialSource;
}

export type PublisherPreparation =
  | { readonly kind: "ready"; readonly prepared: PreparedPublisher }
  | {
      readonly kind: "blocked";
      readonly reason: PublisherBlockReason;
      readonly status: SafePlatformStatus;
      readonly readiness: Readiness;
      readonly missingFields: readonly string[];
    };

export interface PublisherPrepareInput {
  readonly platform: Platform;
  /** Slot metadata only; decryption happens through the cipher port. */
  readonly slot: EncryptedSlotSnapshot;
  /** Decrypted payload for a D1 slot, or null for Env-only configuration. */
  readonly plaintext: Uint8Array | null;
  readonly config: PlatformConfigView;
  readonly now: IsoInstant;
}

export interface PublisherStrategy {
  /**
   * Pure and synchronous: it decodes, validates, constructs a Publisher and
   * encodes the binding material for the finally selected field group, and
   * must perform zero network work (no login, no token refresh, no WebCrypto).
   *
   * Material rules: the Env-only path covers the complete user/app/target
   * field group; the D1 path covers the slot binding id plus the actual
   * app/target configuration and excludes refresh-varying user tokens.
   */
  prepare(input: PublisherPrepareInput): PublisherPreparation;
}

/**
 * Static installation map owned by the composition root. An uninstalled
 * platform must throw rather than produce a ready envelope.
 */
export interface PlatformStrategyRegistry {
  readonly platforms: readonly Platform[];
  strategyFor(platform: Platform): PublisherStrategy;
}

export function emptyPlatformConfig(platform: Platform): PlatformConfigView {
  return Object.freeze({ platform, values: Object.freeze({}), publicUrl: null });
}
