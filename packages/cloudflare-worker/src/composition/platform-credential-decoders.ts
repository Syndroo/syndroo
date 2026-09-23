/**
 * Canonical credential records for the installed platforms.
 *
 * One table owns the allowlisted field names, the plain-configuration mapping
 * and the provider validation call, so a direct set body, an encrypted D1
 * payload and the publishing strategy cannot drift apart. This is Worker
 * composition: it imports provider packages and the frozen application
 * contracts, never a Cloudflare binding, and it performs no network, storage or
 * cryptographic work.
 *
 * Provider packages own credential validation. Nothing here copies their
 * regexes, and no value is cast into a provider credential type: every provider
 * call receives a plain record, exactly like the publishing strategy does.
 */

import type { SafeTarget } from "@syndroo/application";
import { isPlatform, type Platform } from "@syndroo/core";

import { validateBlueskyHost } from "@syndroo/bluesky";
import { decodeLinkedInCredential } from "@syndroo/linkedin";
import { normalizeTumblrBlog } from "@syndroo/tumblr";

/** Platforms with an installed publisher package and a strategy. */
export type InstalledPlatform = "bluesky" | "threads" | "x" | "tumblr" | "linkedin";

/** Every platform the Worker installs, in a fixed order. */
export const INSTALLED_PLATFORMS: readonly InstalledPlatform[] = Object.freeze([
  "bluesky",
  "threads",
  "x",
  "tumblr",
  "linkedin",
]);

/**
 * Payload generation of the encrypted credential record.
 *
 * The value travels in the envelope metadata, so a stored record is only
 * decoded when the slot advertises this exact generation.
 */
export const CREDENTIAL_PAYLOAD_SCHEMA_VERSION = 1;

/**
 * Canonical plaintext bound.
 *
 * It matches the existing 64 KiB auth request-body limit: a canonical record is
 * always far smaller than that, and no per-field limit is invented here, so a
 * valid provider token can never be rejected by an arbitrary cap.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Fixed, message-free failure of a direct credential body.
 *
 * `code` is a closed enum and `field` is either an own, fixed field name of the
 * platform's field table or null. A caller-supplied key never becomes `field`,
 * because an unknown key can itself be a secret; a runtime can therefore build
 * its own error envelope without echoing caller text, provider text or
 * credential values.
 */
export type PlatformCredentialInputErrorCode =
  | "unknown_platform"
  | "invalid_body"
  | "unknown_field"
  | "missing_field"
  | "invalid_field";

const INPUT_ERROR_MESSAGES: Readonly<Record<PlatformCredentialInputErrorCode, string>> =
  Object.freeze({
    unknown_platform: "this platform has no installed credential decoder",
    invalid_body: "the credential body is not a supported record",
    unknown_field: "the credential body contains a field this platform does not accept",
    missing_field: "the credential body is missing a required user token field",
    invalid_field: "the credential body contains an invalid field value",
  });

export class PlatformCredentialInputError extends Error {
  readonly code: PlatformCredentialInputErrorCode;
  readonly field: string | null;

  constructor(code: PlatformCredentialInputErrorCode, field: string | null = null) {
    super(INPUT_ERROR_MESSAGES[code]);
    this.name = "PlatformCredentialInputError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Role of one credential field.
 *
 * `user` fields form the complete user group that must never be assembled from
 * two accounts, `app` fields are runtime secrets the composition root injects
 * from instance configuration, and `target` fields are the documented optional
 * target/configuration fallbacks.
 */
export type CredentialFieldRole = "user" | "app" | "target";

export interface PlatformCredentialField {
  /** Canonical record name; identical to the provider decoder's input key. */
  readonly name: string;
  /** Allowlisted plain-configuration name, or null when it is storage-only. */
  readonly configKey: string | null;
  readonly role: CredentialFieldRole;
  /** Whether a complete group needs this field to resolve to a value. */
  readonly required: boolean;
  /** Documented fallback for an optional target/configuration field. */
  readonly defaultValue?: string;
}

export interface PlatformCredentialSpec {
  readonly platform: InstalledPlatform;
  readonly fields: readonly PlatformCredentialField[];
  /** Field names a stored payload or a direct body may carry. */
  readonly payloadFieldNames: readonly string[];
  /** Field names that form the user group. */
  readonly userFieldNames: readonly string[];
  /** True when the platform always combines D1 credentials with Env app fields. */
  readonly usesEnvRuntimeFields: boolean;
}

const BLUESKY_FIELDS = [
  { name: "identifier", configKey: "BLUESKY_IDENTIFIER", role: "user", required: true },
  { name: "password", configKey: "BLUESKY_PASSWORD", role: "user", required: true },
  {
    name: "host",
    configKey: "BLUESKY_HOST",
    role: "target",
    required: true,
    defaultValue: "bsky.social",
  },
] as const satisfies readonly PlatformCredentialField[];

const THREADS_FIELDS = [
  { name: "access_token", configKey: "THREADS_ACCESS_TOKEN", role: "user", required: true },
] as const satisfies readonly PlatformCredentialField[];

const X_FIELDS = [
  { name: "api_key", configKey: "X_API_KEY", role: "app", required: true },
  { name: "api_secret", configKey: "X_API_SECRET", role: "app", required: true },
  { name: "access_token", configKey: "X_ACCESS_TOKEN", role: "user", required: true },
  {
    name: "access_token_secret",
    configKey: "X_ACCESS_TOKEN_SECRET",
    role: "user",
    required: true,
  },
] as const satisfies readonly PlatformCredentialField[];

const TUMBLR_FIELDS = [
  { name: "consumer_key", configKey: "TUMBLR_CONSUMER_KEY", role: "app", required: true },
  { name: "consumer_secret", configKey: "TUMBLR_CONSUMER_SECRET", role: "app", required: true },
  { name: "token", configKey: "TUMBLR_TOKEN", role: "user", required: true },
  { name: "token_secret", configKey: "TUMBLR_TOKEN_SECRET", role: "user", required: true },
  { name: "blog", configKey: "TUMBLR_BLOG", role: "target", required: true },
] as const satisfies readonly PlatformCredentialField[];

const LINKEDIN_FIELDS = [
  { name: "access_token", configKey: "LINKEDIN_ACCESS_TOKEN", role: "user", required: true },
  { name: "refresh_token", configKey: null, role: "user", required: false },
  { name: "author", configKey: "LINKEDIN_AUTHOR", role: "target", required: true },
  {
    name: "api_version",
    configKey: "LINKEDIN_API_VERSION",
    role: "target",
    required: true,
    defaultValue: "202604",
  },
] as const satisfies readonly PlatformCredentialField[];

function defineSpec(
  platform: InstalledPlatform,
  fields: readonly PlatformCredentialField[],
): PlatformCredentialSpec {
  return Object.freeze({
    platform,
    fields,
    payloadFieldNames: Object.freeze(
      fields.filter((field) => field.role !== "app").map((field) => field.name),
    ),
    userFieldNames: Object.freeze(
      fields.filter((field) => field.role === "user").map((field) => field.name),
    ),
    usesEnvRuntimeFields: fields.some((field) => field.role === "app"),
  });
}

export const PLATFORM_CREDENTIAL_SPECS: Readonly<
  Record<InstalledPlatform, PlatformCredentialSpec>
> = Object.freeze({
  bluesky: defineSpec("bluesky", BLUESKY_FIELDS),
  threads: defineSpec("threads", THREADS_FIELDS),
  x: defineSpec("x", X_FIELDS),
  tumblr: defineSpec("tumblr", TUMBLR_FIELDS),
  linkedin: defineSpec("linkedin", LINKEDIN_FIELDS),
});

/** Field group of one installed platform. */
export function credentialSpecFor(platform: InstalledPlatform): PlatformCredentialSpec {
  return PLATFORM_CREDENTIAL_SPECS[platform];
}

/** Allowlisted plain-configuration names of one installed platform. */
export function platformConfigKeys(platform: InstalledPlatform): readonly string[] {
  return Object.freeze(
    PLATFORM_CREDENTIAL_SPECS[platform].fields
      .map((field) => field.configKey)
      .filter((key): key is string => key !== null),
  );
}

/**
 * Direct-body shape frozen by the Task 6 preparation boundary.
 *
 * `plaintext` is bounded canonical JSON of the complete submitted group,
 * `payloadSchemaVersion` is the envelope generation it must be stored with,
 * `expiresAt` is null because a direct body carries no expiry field, and
 * `target` is validated safe metadata or null.
 */
export interface DirectCredentialDecode {
  readonly plaintext: Uint8Array;
  readonly payloadSchemaVersion: typeof CREDENTIAL_PAYLOAD_SCHEMA_VERSION;
  readonly expiresAt: string | null;
  readonly target: SafeTarget | null;
}

type ParsedFields =
  | { readonly kind: "fields"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "unknown_field" }
  | { readonly kind: "invalid" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFieldValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || CONTROL_CHARACTER.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Read only allowlisted fields with bounded string values.
 *
 * Unknown names, non-string values, blank values and control characters are
 * rejected here, so nothing downstream has to re-check the shape of a submitted
 * or stored group. Length limits come from the canonical payload bound and the
 * providers' own validation, never from an invented per-field cap.
 */
function parseAllowlistedFields(allowed: readonly string[], value: unknown): ParsedFields {
  const record = asRecord(value);
  if (record === null) {
    return { kind: "invalid" };
  }
  const names = Object.keys(record);
  for (const name of names) {
    if (!allowed.includes(name)) {
      return { kind: "unknown_field" };
    }
  }
  const fields: Record<string, string> = {};
  for (const name of names) {
    const field = readFieldValue(record[name]);
    if (field === null) {
      return { kind: "invalid" };
    }
    fields[name] = field;
  }
  return { kind: "fields", fields: Object.freeze(fields) };
}

/**
 * Strict parser for a stored payload group or a direct body.
 *
 * Returns null for every structural failure. The direct decoder turns that into
 * a fixed input error; the publishing strategy turns it into a blocked
 * envelope, because a stored record must never authorize a fallback.
 */
export function parseCredentialFields(
  platform: InstalledPlatform,
  value: unknown,
): Readonly<Record<string, string>> | null {
  const parsed = parseAllowlistedFields(
    PLATFORM_CREDENTIAL_SPECS[platform].payloadFieldNames,
    value,
  );
  return parsed.kind === "fields" ? parsed.fields : null;
}

/** Decode bounded UTF-8 canonical JSON into an allowlisted field group. */
export function decodeCredentialPayloadBytes(
  platform: InstalledPlatform,
  bytes: Uint8Array,
): Readonly<Record<string, string>> | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PAYLOAD_BYTES) {
    return null;
  }
  let text: string;
  try {
    // `ignoreBOM` is part of the standard options bag; the Workers and Node
    // type sets disagree on whether it is optional, and a BOM would corrupt a
    // credential value anyway.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseCredentialFields(platform, parsed);
}

function encodeCanonicalPayload(fields: Readonly<Record<string, string>>): Uint8Array {
  const ordered: Record<string, string> = {};
  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    if (value !== undefined) {
      ordered[name] = value;
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(ordered));
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new PlatformCredentialInputError("invalid_body");
  }
  return bytes;
}

// Probe values satisfy the provider's other two rules, so a single-field
// validation call can only fail because of the value under test. Reusing the
// provider decoder keeps this module from copying its regexes.
const LINKEDIN_PROBE_TOKEN = "probe";
const LINKEDIN_PROBE_AUTHOR = "urn:li:person:probe";
const LINKEDIN_PROBE_API_VERSION = "202601";

function validatedLinkedInField(
  field: "access_token" | "author" | "api_version",
  value: string,
): string | null {
  let credential;
  try {
    credential = decodeLinkedInCredential({
      access_token: LINKEDIN_PROBE_TOKEN,
      author: LINKEDIN_PROBE_AUTHOR,
      api_version: LINKEDIN_PROBE_API_VERSION,
      [field]: value,
    });
  } catch {
    return null;
  }
  if (field === "access_token") {
    return credential.accessToken;
  }
  return field === "author" ? credential.author : credential.apiVersion;
}

function validatedBlueskyHost(host: string): string | null {
  try {
    // The provider validates the operator-supplied host and returns an origin.
    return validateBlueskyHost(host).replace("https://", "");
  } catch {
    return null;
  }
}

function validatedTumblrBlog(blog: string): string | null {
  try {
    return normalizeTumblrBlog(blog);
  } catch {
    return null;
  }
}

type DirectDecodeOutcome =
  | { readonly kind: "ok"; readonly value: DirectCredentialDecode }
  | {
      readonly kind: "error";
      readonly code: PlatformCredentialInputErrorCode;
      readonly field: string | null;
    };

/**
 * Own field names are the only names a public error may carry: they come from
 * the platform's fixed field table, never from a caller-supplied key.
 */
function ownFieldName(spec: PlatformCredentialSpec, name: string): string | null {
  return spec.fields.some((field) => field.name === name) ? name : null;
}

function tryDecodeDirectCredential(
  platform: Platform,
  input: unknown,
): DirectDecodeOutcome {
  if (!isPlatform(platform) || !Object.hasOwn(PLATFORM_CREDENTIAL_SPECS, platform)) {
    return { kind: "error", code: "unknown_platform", field: null };
  }
  const spec = PLATFORM_CREDENTIAL_SPECS[platform as InstalledPlatform];
  const parsed = parseAllowlistedFields(spec.payloadFieldNames, input);
  if (parsed.kind === "unknown_field") {
    // The key itself may be a secret, so it is never echoed back.
    return { kind: "error", code: "unknown_field", field: null };
  }
  if (parsed.kind !== "fields") {
    return { kind: "error", code: "invalid_body", field: null };
  }
  const fields = parsed.fields;
  const missing = spec.fields.find(
    (field) => field.role === "user" && field.required && fields[field.name] === undefined,
  );
  if (missing !== undefined) {
    return { kind: "error", code: "missing_field", field: ownFieldName(spec, missing.name) };
  }
  const invalid = (name: string): DirectDecodeOutcome => ({
    kind: "error",
    code: "invalid_field",
    field: ownFieldName(spec, name),
  });

  // Per-field provider validation. A rejected value never becomes stored
  // metadata, and the resulting error names only an own field.
  const accessToken = fields["access_token"];
  if (
    accessToken !== undefined &&
    spec.platform === "linkedin" &&
    validatedLinkedInField("access_token", accessToken) === null
  ) {
    return invalid("access_token");
  }
  const apiVersion = fields["api_version"];
  if (apiVersion !== undefined && validatedLinkedInField("api_version", apiVersion) === null) {
    return invalid("api_version");
  }

  let target: SafeTarget | null = null;
  const host = fields["host"];
  if (host !== undefined && spec.platform === "bluesky") {
    const label = validatedBlueskyHost(host);
    if (label === null) {
      return invalid("host");
    }
    target = { label, source: "user" };
  }
  const blog = fields["blog"];
  if (blog !== undefined && spec.platform === "tumblr") {
    const label = validatedTumblrBlog(blog);
    if (label === null) {
      return invalid("blog");
    }
    target = { label, source: "user" };
  }
  const author = fields["author"];
  if (author !== undefined && spec.platform === "linkedin") {
    const label = validatedLinkedInField("author", author);
    if (label === null) {
      return invalid("author");
    }
    target = { label, source: "user" };
  }

  return {
    kind: "ok",
    value: Object.freeze({
      plaintext: encodeCanonicalPayload(fields),
      payloadSchemaVersion: CREDENTIAL_PAYLOAD_SCHEMA_VERSION,
      expiresAt: null,
      target,
    }),
  };
}

/**
 * Validate one direct credential body and produce its storable payload.
 *
 * The complete user group is required; runtime app secrets and every unknown or
 * control field are rejected. Missing target/configuration is accepted here
 * because preparation reports that readiness separately, and the caller owns
 * `expectedRevision` and every other control field, which never reach this
 * decoder and are never stored.
 *
 * The body is untrusted data: a getter, a proxy trap or a revoked object can
 * throw anything, including a forged instance of this class. Such an error is
 * never forwarded, and no error carries caller text, provider text or a
 * credential value outward.
 */
export function decodeDirectCredential(
  platform: Platform,
  input: unknown,
): DirectCredentialDecode {
  let outcome: DirectDecodeOutcome;
  try {
    outcome = tryDecodeDirectCredential(platform, input);
  } catch {
    throw new PlatformCredentialInputError("invalid_body");
  }
  if (outcome.kind === "error") {
    throw new PlatformCredentialInputError(outcome.code, outcome.field);
  }
  return outcome.value;
}
