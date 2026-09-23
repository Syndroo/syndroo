/**
 * Static platform preparation strategies for the installed publishers.
 *
 * The composition root owns this module: it maps plain instance configuration
 * into a `PlatformConfigView`, exposes the frozen `PlatformStrategyRegistry`,
 * and prepares one immutable publisher per attempt. Everything here is pure and
 * synchronous. Preparing a publisher performs no platform request, no token
 * refresh, no storage write and no cryptographic work: the typed provider
 * decoders validate the selected group and the provider builders only copy
 * local configuration.
 *
 * Field ownership is exactly the Task 6 credential-resolution table:
 *
 * - an absent slot or an explicit tombstone selects the complete Env user group;
 * - an active slot selects only the decrypted D1 group, and never falls back to
 *   another Env account for a user token;
 * - runtime app fields come from instance configuration, optional target and
 *   configuration fields use only the documented fallbacks.
 */

import {
  InvalidContractInputError,
  compareInstants,
  encodeBindingMaterial,
  isIsoInstant,
  isOpaqueId,
  type BindingMaterial,
  type CredentialSource,
  type PlatformConfigView,
  type PlatformStrategyRegistry,
  type PreparedPublisher,
  type PublisherBlockReason,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
  type Readiness,
  type SafePlatformStatus,
  type SafeTarget,
} from "@syndroo/application";
import type { Platform, Publisher } from "@syndroo/core";

import {
  blueskyAdapter,
  buildBlueskyPublisher,
  decodeBlueskyCredential,
  validateBlueskyHost,
} from "@syndroo/bluesky";
import {
  buildLinkedInPublisher,
  decodeLinkedInCredential,
  linkedinAdapter,
} from "@syndroo/linkedin";
import { buildThreadsPublisher, decodeThreadsCredential, threadsAdapter } from "@syndroo/threads";
import {
  buildTumblrPublisher,
  decodeTumblrCredential,
  normalizeTumblrBlog,
  tumblrAdapter,
} from "@syndroo/tumblr";
import { buildXPublisher, decodeXCredential, xAdapter } from "@syndroo/x";

import {
  CREDENTIAL_PAYLOAD_SCHEMA_VERSION,
  INSTALLED_PLATFORMS,
  PLATFORM_CREDENTIAL_SPECS,
  credentialSpecFor,
  decodeCredentialPayloadBytes,
  platformConfigKeys,
  type CredentialFieldRole,
  type InstalledPlatform,
  type PlatformCredentialField,
  type PlatformCredentialSpec,
} from "./platform-credential-decoders.js";

/**
 * Fixed failure for a platform without an installed strategy.
 *
 * The message never echoes the requested platform, and the registry throws
 * instead of producing an empty or blocked envelope, so an uninstalled platform
 * can never be dispatched.
 */
export class UninstalledPublisherStrategyError extends Error {
  constructor() {
    super("no publisher strategy is installed for this platform");
    this.name = "UninstalledPublisherStrategyError";
  }
}

interface ConstructedGroup {
  readonly publisher: Publisher;
  /** Provider-validated public target label, or null when the platform has none. */
  readonly targetLabel: string | null;
}

interface StrategyDefinition {
  readonly platform: InstalledPlatform;
  readonly spec: PlatformCredentialSpec;
  readonly oauthSupported: boolean;
  /**
   * Typed provider construction: the package decoder validates the resolved
   * record and the builder copies it. No credential value is cast.
   */
  readonly construct: (record: Readonly<Record<string, string>>) => ConstructedGroup;
  /**
   * Normalizes a stored target label before comparing it with the validated
   * label. Absent when the platform's label is already exact.
   */
  readonly normalizeStoredLabel?: (value: string) => string;
}

const DEFINITIONS: Readonly<Record<InstalledPlatform, StrategyDefinition>> = Object.freeze({
  bluesky: {
    platform: "bluesky",
    spec: credentialSpecFor("bluesky"),
    oauthSupported: blueskyAdapter.oauth !== undefined,
    construct: (record) => {
      const credential = decodeBlueskyCredential(record);
      return { publisher: buildBlueskyPublisher(credential), targetLabel: credential.host };
    },
    normalizeStoredLabel: (value) => validateBlueskyHost(value).replace("https://", ""),
  },
  threads: {
    platform: "threads",
    spec: credentialSpecFor("threads"),
    oauthSupported: threadsAdapter.oauth !== undefined,
    construct: (record) => ({
      publisher: buildThreadsPublisher(decodeThreadsCredential(record)),
      targetLabel: null,
    }),
  },
  x: {
    platform: "x",
    spec: credentialSpecFor("x"),
    oauthSupported: xAdapter.oauth !== undefined,
    construct: (record) => ({
      publisher: buildXPublisher(decodeXCredential(record)),
      targetLabel: null,
    }),
  },
  tumblr: {
    platform: "tumblr",
    spec: credentialSpecFor("tumblr"),
    oauthSupported: tumblrAdapter.oauth !== undefined,
    construct: (record) => {
      const credential = decodeTumblrCredential(record);
      return { publisher: buildTumblrPublisher(credential), targetLabel: credential.blog };
    },
    normalizeStoredLabel: normalizeTumblrBlog,
  },
  linkedin: {
    platform: "linkedin",
    spec: credentialSpecFor("linkedin"),
    oauthSupported: linkedinAdapter.oauth !== undefined,
    construct: (record) => {
      const credential = decodeLinkedInCredential(record);
      return { publisher: buildLinkedInPublisher(credential), targetLabel: credential.author };
    },
  },
});

const STRATEGIES: Readonly<Record<InstalledPlatform, PublisherStrategy>> = Object.freeze({
  bluesky: createStrategy(DEFINITIONS.bluesky),
  threads: createStrategy(DEFINITIONS.threads),
  x: createStrategy(DEFINITIONS.x),
  tumblr: createStrategy(DEFINITIONS.tumblr),
  linkedin: createStrategy(DEFINITIONS.linkedin),
});

/**
 * Installation map for the five bundled platforms.
 *
 * Cases are fixed and literal: a new platform has to be added here and in the
 * field table, and an uninstalled platform throws instead of resolving to a
 * strategy that cannot dispatch.
 */
export const platformStrategyRegistry: PlatformStrategyRegistry = Object.freeze({
  platforms: INSTALLED_PLATFORMS,
  strategyFor(platform: Platform): PublisherStrategy {
    return strategyFor(platform);
  },
});

function strategyFor(platform: Platform): PublisherStrategy {
  switch (platform) {
    case "bluesky":
    case "threads":
    case "x":
    case "tumblr":
    case "linkedin":
      return STRATEGIES[platform];
    default:
      throw new UninstalledPublisherStrategyError();
  }
}

function definitionFor(platform: Platform): StrategyDefinition {
  switch (platform) {
    case "bluesky":
    case "threads":
    case "x":
    case "tumblr":
    case "linkedin":
      return DEFINITIONS[platform];
    default:
      throw new UninstalledPublisherStrategyError();
  }
}

/**
 * Map plain instance configuration into a platform configuration view.
 *
 * The input is an explicit string map, never an `Env` object: only the
 * allowlisted configuration names of that platform are copied, values are
 * trimmed, blanks are dropped and the result is frozen.
 */
export function platformConfigView(
  platform: Platform,
  values: Readonly<Record<string, string | undefined>>,
  publicUrl: string | null = null,
): PlatformConfigView {
  const definition = definitionFor(platform);
  const mapped: Record<string, string> = {};
  for (const key of platformConfigKeys(definition.platform)) {
    const raw = values[key];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue;
    }
    mapped[key] = trimmed;
  }
  return Object.freeze({
    platform: definition.platform,
    values: Object.freeze(mapped),
    publicUrl,
  });
}

function createStrategy(definition: StrategyDefinition): PublisherStrategy {
  return Object.freeze({
    prepare(input: PublisherPrepareInput): PublisherPreparation {
      return prepareForPlatform(definition, input);
    },
  });
}

interface BlockDetails {
  readonly reason: PublisherBlockReason;
  readonly source: CredentialSource;
  readonly target: SafeTarget | null;
  readonly missingFields: readonly string[];
  readonly expiresAt: string | null;
}

function readinessFor(reason: PublisherBlockReason): Readiness {
  switch (reason) {
    case "missing_credentials":
      return "missing_credentials";
    case "needs_configuration":
      return "needs_configuration";
    case "expired":
      return "expired";
    case "reconnect_required":
      return "reconnect_required";
    case "invalid_configuration":
    case "unavailable":
      return "unavailable";
  }
}

function safeRevision(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function blockedPreparation(
  definition: StrategyDefinition,
  input: PublisherPrepareInput,
  details: BlockDetails,
): PublisherPreparation {
  const missingFields = Object.freeze([...details.missingFields]);
  const status: SafePlatformStatus = Object.freeze({
    platform: definition.platform,
    configured: false,
    source: details.source,
    oauthSupported: definition.oauthSupported,
    readiness: readinessFor(details.reason),
    missingFields,
    expiresAt: details.expiresAt,
    revision: safeRevision(input.slot.revision),
    ...(details.target === null ? {} : { target: details.target }),
  });
  return Object.freeze({
    kind: "blocked",
    reason: details.reason,
    status,
    readiness: status.readiness,
    missingFields,
  });
}

interface GroupResolution {
  /** Complete provider-shaped record: field name to resolved value. */
  readonly record: Readonly<Record<string, string>>;
  /** Missing fields, reported through the fixed public configuration allowlist. */
  readonly missingFields: readonly string[];
  readonly missingUserFields: readonly string[];
  /** True when at least one value was selected from instance configuration. */
  readonly envFieldsUsed: boolean;
}

/**
 * Resolve one field group.
 *
 * A stored value wins, then the allowlisted instance configuration, then the
 * documented default of an optional target/configuration field. This is the
 * documented fallback table and it never fills half of a user token pair from
 * another source: a missing user field stays missing here and blocks the
 * preparation. Only runtime app fields and optional target/configuration fields
 * may fall back to instance configuration.
 */
function resolveGroupFields(
  spec: PlatformCredentialSpec,
  storedFields: Readonly<Record<string, string>> | null,
  configValues: Readonly<Record<string, string>>,
): GroupResolution {
  const record: Record<string, string> = {};
  const missingFields: string[] = [];
  const missingUserFields: string[] = [];
  let envFieldsUsed = false;
  for (const field of spec.fields) {
    let value = storedFields === null ? undefined : storedFields[field.name];
    const mayUseInstanceConfig = storedFields === null || field.role !== "user";
    if (value === undefined && mayUseInstanceConfig && field.configKey !== null) {
      const fromConfig = configValues[field.configKey];
      if (fromConfig !== undefined) {
        value = fromConfig;
        envFieldsUsed = true;
      }
    }
    if (value === undefined) {
      value = field.defaultValue;
    }
    if (value === undefined) {
      if (field.required) {
        missingFields.push(publicFieldName(field));
        if (field.role === "user") {
          missingUserFields.push(publicFieldName(field));
        }
      }
      continue;
    }
    record[field.name] = value;
  }
  return Object.freeze({
    record: Object.freeze(record),
    missingFields: Object.freeze(missingFields),
    missingUserFields: Object.freeze(missingUserFields),
    envFieldsUsed,
  });
}

/** Public, fixed vocabulary for a missing configuration item. */
function publicFieldName(field: PlatformCredentialField): string {
  return field.configKey ?? field.name;
}

function groupedPairs(
  spec: PlatformCredentialSpec,
  role: CredentialFieldRole,
  record: Readonly<Record<string, string>>,
): readonly (readonly [string, string | null])[] {
  return spec.fields
    .filter((field) => field.role === role)
    .map((field) => [field.name, record[field.name] ?? null] as const);
}

/**
 * Source of a ready selection: Env-only is `env`, an active slot that selected
 * at least one instance value is `mixed`, and an active slot that needed no
 * instance value is `credential`.
 */
function selectedSource(
  slotSelectsCredential: boolean,
  resolution: GroupResolution,
): "env" | "credential" | "mixed" {
  if (!slotSelectsCredential) {
    return "env";
  }
  return resolution.envFieldsUsed ? "mixed" : "credential";
}

/**
 * Source of a blocked preparation.
 *
 * A missing user group has source null; a blocked selected D1 group retains its
 * selected source where known. When the selected group's fields could not be
 * resolved at all, the platform's structural requirement of instance app fields
 * is the conservative answer.
 */
function blockedSource(
  spec: PlatformCredentialSpec,
  slotSelectsCredential: boolean,
  resolution: GroupResolution | null,
): CredentialSource {
  if (resolution === null) {
    if (!slotSelectsCredential) {
      return null;
    }
    return spec.usesEnvRuntimeFields ? "mixed" : "credential";
  }
  if (!slotSelectsCredential) {
    return resolution.missingUserFields.length === 0 ? "env" : null;
  }
  return resolution.envFieldsUsed ? "mixed" : "credential";
}

/**
 * Provenance of the public target label.
 *
 * The label always comes from the provider-validated credential. Stored
 * metadata may only upgrade provenance to `provider`, and only when its own
 * label normalizes to exactly that validated label; anything else stays `user`
 * and never reaches a status DTO.
 */
function targetProvenance(
  definition: StrategyDefinition,
  input: PublisherPrepareInput,
  slotSelectsCredential: boolean,
  label: string,
): "user" | "provider" {
  if (!slotSelectsCredential) {
    return "user";
  }
  const stored = input.slot.target;
  if (stored === null) {
    return "user";
  }
  const normalize = definition.normalizeStoredLabel;
  if (normalize === undefined) {
    return stored.label === label ? stored.source : "user";
  }
  try {
    return normalize(stored.label) === label ? stored.source : "user";
  } catch {
    return "user";
  }
}

function prepareForPlatform(
  definition: StrategyDefinition,
  input: PublisherPrepareInput,
): PublisherPreparation {
  const { platform, spec } = definition;
  const now = input.now;
  // The persisted status is untrusted runtime data: anything other than the
  // three known slot states is a corrupt record, never an absent slot.
  const slotStatus: string = input.slot.status;
  const slotSelectsCredential = slotStatus === "active";
  const structuralSource: CredentialSource = slotSelectsCredential
    ? spec.usesEnvRuntimeFields
      ? "mixed"
      : "credential"
    : null;

  // Fail closed on inconsistent input before reading anything else: a slot,
  // configuration view or call that belongs to another platform can never
  // authorize work for this one.
  if (
    input.platform !== platform ||
    input.slot.platform !== platform ||
    input.config.platform !== platform
  ) {
    return blockedPreparation(definition, input, {
      reason: "invalid_configuration",
      source: structuralSource,
      target: null,
      missingFields: [],
      expiresAt: null,
    });
  }
  if (!isIsoInstant(now)) {
    // Wiring error, not caller input: the caller supplies an already
    // normalized observation instant.
    throw new InvalidContractInputError("prepare requires a canonical UTC observation instant");
  }
  if (!Number.isSafeInteger(input.slot.revision) || input.slot.revision < 0) {
    return blockedPreparation(definition, input, {
      reason: "invalid_configuration",
      source: structuralSource,
      target: null,
      missingFields: [],
      expiresAt: null,
    });
  }
  if (slotStatus !== "active" && slotStatus !== "empty" && slotStatus !== "tombstone") {
    return blockedPreparation(definition, input, {
      reason: "invalid_configuration",
      source: null,
      target: null,
      missingFields: [],
      expiresAt: null,
    });
  }

  let storedFields: Readonly<Record<string, string>> | null = null;
  let selectedExpiry: string | null = null;
  if (slotSelectsCredential) {
    const read = readSelectedCredential(definition, input, now, structuralSource);
    if (read.kind === "blocked") {
      return blockedPreparation(definition, input, read.details);
    }
    storedFields = read.storedFields;
    selectedExpiry = read.expiresAt;
  } else if (input.plaintext !== null) {
    // An absent slot carries no decrypted payload.
    return blockedPreparation(definition, input, {
      reason: "invalid_configuration",
      source: null,
      target: null,
      missingFields: [],
      expiresAt: null,
    });
  }

  const resolution = resolveGroupFields(spec, storedFields, input.config.values);
  if (resolution.missingFields.length > 0) {
    return blockedPreparation(definition, input, {
      reason:
        resolution.missingUserFields.length > 0 ? "missing_credentials" : "needs_configuration",
      source: blockedSource(spec, slotSelectsCredential, resolution),
      target: null,
      missingFields: resolution.missingFields,
      expiresAt: selectedExpiry,
    });
  }

  let constructed: ConstructedGroup;
  try {
    constructed = definition.construct(resolution.record);
  } catch {
    // Provider validation is the last gate. Its message never leaves this
    // frame: a rejected group is reported as invalid configuration.
    return blockedPreparation(definition, input, {
      reason: "invalid_configuration",
      source: blockedSource(spec, slotSelectsCredential, resolution),
      target: null,
      missingFields: [],
      expiresAt: selectedExpiry,
    });
  }

  const source = selectedSource(slotSelectsCredential, resolution);
  const target: SafeTarget | null =
    constructed.targetLabel === null
      ? null
      : Object.freeze({
          label: constructed.targetLabel,
          source: targetProvenance(
            definition,
            input,
            slotSelectsCredential,
            constructed.targetLabel,
          ),
        });

  // Fixed field arrays through the canonical encoder. The Env-only path covers
  // the complete selected user/app/target group with explicit null optionals;
  // the D1 path covers the slot binding id plus app/target configuration and
  // excludes refresh-varying user tokens, so a same-grant token rotation keeps
  // the connection identity.
  const materialFields: readonly (readonly [string, string | null])[] = slotSelectsCredential
    ? [
        ["slotBinding", input.slot.bindingId ?? null] as const,
        ...groupedPairs(spec, "app", resolution.record),
        ...groupedPairs(spec, "target", resolution.record),
      ]
    : [
        ...groupedPairs(spec, "user", resolution.record),
        ...groupedPairs(spec, "app", resolution.record),
        ...groupedPairs(spec, "target", resolution.record),
      ];
  const bindingMaterial: BindingMaterial = encodeBindingMaterial({
    platform,
    source,
    fields: materialFields,
  });

  const status: SafePlatformStatus = Object.freeze({
    platform,
    configured: true,
    source,
    oauthSupported: definition.oauthSupported,
    readiness: "ready",
    missingFields: Object.freeze<string[]>([]),
    expiresAt: selectedExpiry,
    revision: input.slot.revision,
    ...(target === null ? {} : { target }),
  });
  const prepared: PreparedPublisher = Object.freeze({
    platform,
    publisher: constructed.publisher,
    status,
    target,
    slotBindingId: slotSelectsCredential ? input.slot.bindingId : null,
    bindingMaterial,
    credentialRevision: input.slot.revision,
    credentialSource: source,
  });
  return Object.freeze({ kind: "ready", prepared });
}

type SelectedCredentialRead =
  | { readonly kind: "blocked"; readonly details: BlockDetails }
  | {
      readonly kind: "selected";
      readonly storedFields: Readonly<Record<string, string>>;
      readonly expiresAt: string | null;
    };

/**
 * Read the complete encrypted group of a selected D1 slot.
 *
 * Every failure here blocks the selected slot: an active slot is never an
 * absent slot, so a missing envelope, an unexpected payload generation, an
 * unusable binding id, an unavailable plaintext, an invalid internal date or an
 * expired credential can never fall back to Env user credentials.
 */
function readSelectedCredential(
  definition: StrategyDefinition,
  input: PublisherPrepareInput,
  now: string,
  source: CredentialSource,
): SelectedCredentialRead {
  const blocked = (details: BlockDetails): SelectedCredentialRead =>
    Object.freeze({ kind: "blocked", details });
  const details = (
    reason: PublisherBlockReason,
    expiresAt: string | null,
  ): BlockDetails => ({ reason, source, target: null, missingFields: [], expiresAt });

  // A live refresh lease defers new preparation; an expired or unreadable lease
  // means the exchange result is unknown, so this connection has to be
  // reconnected explicitly. Neither read clears the lease.
  if (input.slot.refreshState === "reconnect_required") {
    return blocked(details("reconnect_required", null));
  }
  const lease = input.slot.refreshLease;
  if (lease !== null) {
    const live = isIsoInstant(lease.expiresAt) && compareInstants(lease.expiresAt, now) > 0;
    return blocked(details(live ? "unavailable" : "reconnect_required", null));
  }
  if (
    input.slot.envelope === null ||
    input.slot.payloadSchemaVersion !== CREDENTIAL_PAYLOAD_SCHEMA_VERSION ||
    !isOpaqueId(input.slot.bindingId)
  ) {
    return blocked(details("invalid_configuration", null));
  }
  const plaintext = input.plaintext;
  if (plaintext === null) {
    // The selected group exists but its plaintext is unavailable, which is
    // never an absent slot.
    return blocked(details("unavailable", null));
  }
  const slotExpiry = input.slot.expiresAt;
  let expiresAt: string | null = null;
  if (slotExpiry !== null) {
    if (!isIsoInstant(slotExpiry)) {
      // An invalid internal date is unavailable, not permanent validity.
      return blocked(details("unavailable", null));
    }
    if (compareInstants(slotExpiry, now) <= 0) {
      return blocked(details("expired", slotExpiry));
    }
    expiresAt = slotExpiry;
  }
  const storedFields = decodeCredentialPayloadBytes(definition.platform, plaintext);
  if (storedFields === null) {
    return blocked(details("invalid_configuration", expiresAt));
  }
  return Object.freeze({ kind: "selected", storedFields, expiresAt });
}

/** Every installed platform, exposed for composition and configuration reads. */
export const installedPlatforms: readonly InstalledPlatform[] = INSTALLED_PLATFORMS;

/** Field table of one installed platform, exposed for the direct decoder wiring. */
export const platformCredentialSpecs: Readonly<
  Record<InstalledPlatform, PlatformCredentialSpec>
> = PLATFORM_CREDENTIAL_SPECS;
