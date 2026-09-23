/**
 * Lazy runtime dependency composition (design §7 "Construction and error
 * mapping").
 *
 * The factory copies the allowlisted plain-string configuration exactly once
 * (each name is read at most once), keeps no mutable configuration object, and
 * performs no key validation, database, queue or provider operation while
 * constructing. Cipher and binding adapters are built lazily on first use and
 * cached only after they succeed, so status, removal and idempotent/completed
 * replay stay possible on an instance whose keys are absent or invalid.
 *
 * Preparation is not reimplemented here: the accepted shared
 * `createPreparePublisher` closure owns slot reading, trusted AAD identity,
 * blocked-status semantics and controlled storage failures. This module only
 * supplies its lazy read-cipher lookup, the frozen configuration view and the
 * accepted strategy registry, so one closure serves status, admission and
 * execution.
 *
 * No application module receives an `Env`, a queue handle or request headers:
 * only frozen string maps cross this boundary.
 */

import {
  createPreparePublisher,
  type BindingMaterial,
  type BindingSigner,
  type CredentialCipher,
  type CredentialStore,
  type IsoInstant,
  type PlatformConfigView,
  type PreparePublisher,
} from "@syndroo/application";
import type { Platform } from "@syndroo/core";

import { createAesGcmCipher } from "../infrastructure/crypto/aes-gcm-cipher.js";
import { createHmacBindingSigner } from "../infrastructure/crypto/hmac-binding-signer.js";
import { decodeAes256Key, decodeBindingKey, requireKeyId } from "../infrastructure/crypto/keys.js";
import { LINKEDIN_APP_FIELDS, TUMBLR_APP_FIELDS, X_APP_FIELDS } from "./oauth-drivers.js";
import { parsePublicOrigin } from "./oauth-protocol-support.js";
import { INSTALLED_PLATFORMS, platformConfigKeys } from "./platform-credential-decoders.js";
import { platformConfigView, platformStrategyRegistry } from "./platform-strategies.js";

/** Exact instance setting names (design §10 and the accepted SDK allowlist). */
export const CREDENTIAL_KEY_SETTING = "SYNDROO_CREDENTIAL_KEY";
export const CREDENTIAL_KEY_ID_SETTING = "SYNDROO_CREDENTIAL_KEY_ID";
export const BINDING_KEY_SETTING = "SYNDROO_BINDING_KEY";
export const PUBLIC_URL_SETTING = "SYNDROO_PUBLIC_URL";

/** Publishing identity kinds used by the accepted create use case. */
export type PublishingIdKind = "post" | "publication" | "job";
/** Execution identity kinds used by the accepted consumer. */
export type ExecutionIdKind = "claim" | "attempt" | "job";

/** Structural twin of the accepted application clock hook. */
export interface RuntimeClock {
  now(): IsoInstant;
}

export interface InstanceReadiness {
  readonly publishingReady: boolean;
  /** Fixed setting names only; never a value, a cause or a platform name. */
  readonly missingFields: readonly string[];
}

export interface RuntimeDependenciesInput {
  readonly credentials: CredentialStore;
  /** Plain string configuration; copied once and never retained as-is. */
  readonly values: Readonly<Record<string, string | undefined>>;
}

export interface RuntimeDependencies {
  /** Frozen allowlisted copy; the caller's object is never retained. */
  readonly configuration: Readonly<Record<string, string>>;
  /** Canonical public origin, or null when absent or not an HTTPS origin. */
  readonly publicUrl: string | null;
  readonly instanceReadiness: () => InstanceReadiness;
  readonly configFor: (platform: Platform) => PlatformConfigView;
  /** The accepted shared preparation closure, created once on first use. */
  readonly getPreparePublisher: () => PreparePublisher;
  /** Validates the credential key and key id only, on first use. */
  readonly getReadCipher: () => CredentialCipher;
  /** Additionally proves the independent binding key, on first use. */
  readonly getWriteCipher: () => CredentialCipher;
  readonly bindingSigner: BindingSigner;
  readonly clock: RuntimeClock;
  readonly publishingIds: (kind: PublishingIdKind) => string;
  readonly executionIds: (kind: ExecutionIdKind) => string;
}

export function createRuntimeDependencies(
  input: RuntimeDependenciesInput,
): RuntimeDependencies {
  const configuration = copyAllowlistedConfiguration(input.values);
  const credentials = input.credentials;
  const publicUrl = parsePublicOrigin(configuration[PUBLIC_URL_SETTING] ?? null);

  let readCipher: CredentialCipher | null = null;
  let signer: BindingSigner | null = null;
  let prepare: PreparePublisher | null = null;

  const configFor = (platform: Platform): PlatformConfigView =>
    platformConfigView(platform, configuration, publicUrl);

  const getReadCipher = (): CredentialCipher => {
    if (readCipher !== null) {
      return readCipher;
    }
    // Validates only the credential key and key id, when actually called.
    const key = requireCredentialKey(configuration[CREDENTIAL_KEY_SETTING]);
    const keyId = requireKeyId(configuration[CREDENTIAL_KEY_ID_SETTING]);
    // Freeze the cached adapter at this composition boundary: adapters are
    // unchanged, but a caller cannot swap methods through the returned object.
    const built = Object.freeze(createAesGcmCipher({ key, keyId }));
    readCipher = built;
    return built;
  };

  const getWriteCipher = (): CredentialCipher => {
    // A new credential write also proves the independent binding key exists.
    requireBindingKey(configuration[BINDING_KEY_SETTING]);
    return getReadCipher();
  };

  const bindingSigner: BindingSigner = Object.freeze({
    async sign(material: BindingMaterial) {
      // First sign validates both configurations, then delegates to the
      // accepted HMAC signer.
      requireCredentialKey(configuration[CREDENTIAL_KEY_SETTING]);
      requireKeyId(configuration[CREDENTIAL_KEY_ID_SETTING]);
      const bindingKey = requireBindingKey(configuration[BINDING_KEY_SETTING]);
      signer ??= Object.freeze(createHmacBindingSigner({ key: bindingKey }));
      return signer.sign(material);
    },
  });

  const getPreparePublisher = (): PreparePublisher => {
    prepare ??= createPreparePublisher({
      credentials,
      getCipher: getReadCipher,
      strategies: platformStrategyRegistry,
      configFor,
    });
    return prepare;
  };

  return Object.freeze({
    configuration,
    publicUrl,
    instanceReadiness: (): InstanceReadiness => instanceReadinessOf(configuration),
    configFor,
    getPreparePublisher,
    getReadCipher,
    getWriteCipher,
    bindingSigner,
    clock: Object.freeze({
      now: (): IsoInstant => new Date().toISOString(),
    }),
    publishingIds: (kind: PublishingIdKind): string => `${kind}_${crypto.randomUUID()}`,
    executionIds: (kind: ExecutionIdKind): string => `${kind}_${crypto.randomUUID()}`,
  });
}

// ---------------------------------------------------------------------------
// Configuration copy
// ---------------------------------------------------------------------------

/**
 * Allowlisted plain-configuration names, deduplicated.
 *
 * Publishing names come from the accepted `platformConfigKeys` table, OAuth app
 * names from the accepted driver field lists (which overlap the x/tumblr
 * publishing groups), and the crypto and public-URL names are the exact
 * instance settings documented in design §10. The API key and every unrelated
 * binding are outside this list and are never copied.
 */
export const INSTANCE_CONFIGURATION_NAMES: readonly string[] = Object.freeze([
  ...new Set([
    CREDENTIAL_KEY_SETTING,
    CREDENTIAL_KEY_ID_SETTING,
    BINDING_KEY_SETTING,
    PUBLIC_URL_SETTING,
    ...INSTALLED_PLATFORMS.flatMap((platform) => platformConfigKeys(platform)),
    ...X_APP_FIELDS,
    ...TUMBLR_APP_FIELDS,
    ...LINKEDIN_APP_FIELDS,
  ]),
]);

/**
 * Copy the allowlisted strings exactly once.
 *
 * Each name is read from the caller's object at most once, only string values
 * are kept, and a throwing getter or non-object input is treated as absent
 * rather than escaping - so construction can never fail on caller input and no
 * value is ever echoed in an error.
 */
function copyAllowlistedConfiguration(
  values: Readonly<Record<string, string | undefined>> | null | undefined,
): Readonly<Record<string, string>> {
  const copied: Record<string, string> = {};
  if (typeof values !== "object" || values === null) {
    return Object.freeze(copied);
  }
  for (const key of INSTANCE_CONFIGURATION_NAMES) {
    let raw: unknown;
    try {
      raw = (values as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof raw === "string") {
      copied[key] = raw;
    }
  }
  return Object.freeze(copied);
}

/** Fixed, value-free error path for the credential key. */
function requireCredentialKey(encoded: unknown): string {
  decodeAes256Key(encoded);
  return encoded as string;
}

/** Fixed, value-free error path for the independent binding key. */
function requireBindingKey(encoded: unknown): string {
  decodeBindingKey(encoded);
  return encoded as string;
}

function isValidCredentialKey(encoded: unknown): boolean {
  try {
    decodeAes256Key(encoded);
    return true;
  } catch {
    return false;
  }
}

function isValidBindingKey(encoded: unknown): boolean {
  try {
    decodeBindingKey(encoded);
    return true;
  } catch {
    return false;
  }
}

function isValidKeyId(value: unknown): boolean {
  try {
    requireKeyId(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Instance readiness inspects exactly the three key settings and reports only
 * their fixed names. The public URL is not part of publishing readiness: a
 * missing origin affects OAuth connect only.
 */
function instanceReadinessOf(
  configuration: Readonly<Record<string, string>>,
): InstanceReadiness {
  const missingFields: string[] = [];
  if (!isValidCredentialKey(configuration[CREDENTIAL_KEY_SETTING])) {
    missingFields.push(CREDENTIAL_KEY_SETTING);
  }
  if (!isValidKeyId(configuration[CREDENTIAL_KEY_ID_SETTING])) {
    missingFields.push(CREDENTIAL_KEY_ID_SETTING);
  }
  if (!isValidBindingKey(configuration[BINDING_KEY_SETTING])) {
    missingFields.push(BINDING_KEY_SETTING);
  }
  return Object.freeze({
    publishingReady: missingFields.length === 0,
    missingFields: Object.freeze(missingFields),
  });
}
