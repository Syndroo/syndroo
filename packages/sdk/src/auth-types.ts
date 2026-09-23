/**
 * Wire types, runtime validation, and argument validation for the 0.5.0 auth
 * contract (see docs/v0.5.0/public-api.md).
 *
 * The SDK declares its own wire types and projects responses into fresh
 * objects: unknown fields are dropped, documented fields are checked, and every
 * failure message stays shape-only. Nothing here imports a private package.
 */

import {
  SyndrooValidationError,
  type ErrorSink,
  type SdkOperation,
} from "./errors.js";
import {
  invalid,
  optionalBoolean,
  optionalRecord,
  optionalString,
  requireBoolean,
  requireInstant,
  requireNullableInstant,
  requireRecord,
  requireRevision,
  requireString,
  requireStringArray,
  type ParseContext,
} from "./types.js";

/** Local deadline options; structurally identical to the client's. */
export interface AuthRequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export type Readiness =
  | "ready"
  | "missing_credentials"
  | "needs_configuration"
  | "expired"
  | "reconnect_required"
  | "unavailable";

export type AuthSource = "env" | "credential" | "mixed";

export type AuthPhase =
  | "pending_callback"
  | "exchanging"
  | "awaiting_confirmation"
  | "needs_configuration"
  | "completed"
  | "failed"
  | "expired";

export interface PlatformTarget {
  label: string;
  source: "user" | "provider";
}

export interface PlatformStatus {
  platform: string;
  configured: boolean;
  source: AuthSource | null;
  oauthSupported: boolean;
  readiness: Readiness;
  missingFields: string[];
  expiresAt: string | null;
  revision: number;
  target?: PlatformTarget;
}

export interface InstanceStatus {
  publishingReady: boolean;
  missingFields: string[];
}

export interface AuthStatus {
  instance: InstanceStatus;
  platforms: Record<string, PlatformStatus>;
}

export interface ConnectReceipt {
  platform: string;
  operationId: string;
  url: string;
  expiresAt: string;
  expectedRevision: number;
}

export interface CompleteReceipt {
  platform: string;
  operationId: string;
  stored: true;
  revision: number;
  configured: boolean;
  readiness: Readiness;
  replayed?: boolean;
}

export interface AuthOperationStatus {
  platform: string;
  operationId: string;
  phase: AuthPhase;
  expiresAt: string;
  expectedRevision: number;
  missingFields: string[];
  candidate?: { target?: PlatformTarget };
  active: PlatformStatus;
  receipt?: CompleteReceipt;
  errorCode?: string;
}

export interface AuthSetReceipt {
  platform: string;
  stored: true;
  revision: number;
  configured: boolean;
  readiness: Readiness;
}

export interface AuthRemoveReceipt {
  platform: string;
  removed: true;
  revision: number;
  configured: boolean;
  readiness: Readiness;
}

export interface AuthRefreshReceipt {
  platform: string;
  refreshed: true;
  revision: number;
  configured: boolean;
  readiness: Readiness;
  expiresAt: string | null;
}

/** The flat direct-credential body of `POST /v1/auth/:platform`. */
export type AuthCredentialInput = Record<string, string | undefined>;

export interface AuthCompleteTarget {
  author?: string | undefined;
  api_version?: string | undefined;
  blog?: string | undefined;
}

export interface AuthMutationOptions extends AuthRequestOptions {
  /** The revision this caller observed; a mutation never guesses one. */
  expectedRevision: number;
}

/**
 * The documented third argument of `complete`. Request options stay a separate
 * fourth argument, exactly as `public-api.md` specifies.
 */
export interface AuthCompleteInput {
  expectedRevision: number;
  target?: AuthCompleteTarget | undefined;
}

const READINESS_VALUES: ReadonlySet<string> = new Set([
  "ready",
  "missing_credentials",
  "needs_configuration",
  "expired",
  "reconnect_required",
  "unavailable",
]);

const SOURCE_VALUES: ReadonlySet<string> = new Set(["env", "credential", "mixed"]);

const PHASE_VALUES: ReadonlySet<string> = new Set([
  "pending_callback",
  "exchanging",
  "awaiting_confirmation",
  "needs_configuration",
  "completed",
  "failed",
  "expired",
]);

/**
 * Public configuration names an instance or platform may report as missing.
 * The list is closed so a server cannot push arbitrary text into a status DTO.
 */
const PUBLIC_FIELD_NAMES: ReadonlySet<string> = new Set([
  "SYNDROO_API_KEY",
  "SYNDROO_BINDING_KEY",
  "SYNDROO_CREDENTIAL_KEY",
  "SYNDROO_CREDENTIAL_KEY_ID",
  "BLUESKY_IDENTIFIER",
  "BLUESKY_PASSWORD",
  "BLUESKY_HOST",
  "THREADS_ACCESS_TOKEN",
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
  "TUMBLR_CONSUMER_KEY",
  "TUMBLR_CONSUMER_SECRET",
  "TUMBLR_TOKEN",
  "TUMBLR_TOKEN_SECRET",
  "TUMBLR_BLOG",
  "LINKEDIN_ACCESS_TOKEN",
  "LINKEDIN_AUTHOR",
  "LINKEDIN_API_VERSION",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
]);

/**
 * Closed stored-operation error codes. This is exactly the application's
 * `OAuthStoredErrorCode` projection — the cipher and envelope codes included —
 * not the HTTP `AuthErrorCode` envelope.
 */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "PROVIDER_DENIED",
  "PROVIDER_FAILED",
  "INVALID_RESPONSE",
  "DECRYPTION_FAILED",
  "CIPHER_UNAVAILABLE",
  "EXPIRED",
  "CONFIG_CHANGED",
  "TOKEN_MISMATCH",
]);

/** Closed allowlist of candidate configuration names a projection may require. */
const CANDIDATE_FIELDS: ReadonlySet<string> = new Set([
  "author",
  "api_version",
  "blog",
]);

/** Direct credential fields per platform: what a caller may submit. */
const DIRECT_CREDENTIAL_FIELDS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  bluesky: { required: ["identifier", "password"], optional: ["host"] },
  threads: { required: ["access_token"], optional: [] },
  x: { required: ["access_token", "access_token_secret"], optional: [] },
  tumblr: { required: ["token", "token_secret"], optional: ["blog"] },
  linkedin: {
    required: ["access_token"],
    optional: ["author", "api_version", "refresh_token"],
  },
};

/**
 * Completion target fields per platform: everything else is rejected. Required
 * fields are the server's to enforce — a replay of a completed operation can
 * legitimately carry no target — so the SDK only checks supplied keys and value
 * syntax locally.
 */
const COMPLETE_TARGET_FIELDS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  linkedin: { required: [], optional: ["author", "api_version"] },
  tumblr: { required: [], optional: ["blog"] },
  x: { required: [], optional: [] },
};

const LINKEDIN_AUTHOR_PATTERN = /^(?:urn:li:person:[A-Za-z0-9_-]+|urn:li:organization:[1-9][0-9]*)$/u;
const LINKEDIN_VERSION_PATTERN = /^20\d{2}(?:0[1-9]|1[0-2])$/u;
const BLOG_PATTERN = /^[^\s/]+$/u;
const PLATFORM_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;

/**
 * A contract failure. The extra sentence tells a caller of an older deployment
 * why the new fields are missing instead of implying a broken server.
 */
function authInvalid(message: string, context: ParseContext): Error {
  return invalid(
    `${message} The deployment may predate the 0.5.0 auth API.`,
    context,
  );
}

/** An identity mismatch: the server answered about something else. */
export function authIdentityError(message: string, context: ParseContext): Error {
  return invalid(message, context);
}

function requireChoice(
  value: unknown,
  label: string,
  allowed: ReadonlySet<string>,
  context: ParseContext,
): string {
  const choice = requireString(value, label, context);

  if (!allowed.has(choice)) {
    throw authInvalid(`${label} is not one of the documented values`, context);
  }

  return choice;
}

function requirePublicFieldNames(
  value: unknown,
  label: string,
  context: ParseContext,
  allowed: ReadonlySet<string> = PUBLIC_FIELD_NAMES,
): string[] {
  const names = requireStringArray(value, label, context);

  for (const name of names) {
    if (!allowed.has(name)) {
      throw authInvalid(`${label} contains a name this SDK does not document`, context);
    }
  }

  return names;
}

function parseTarget(
  value: unknown,
  label: string,
  context: ParseContext,
): PlatformTarget | undefined {
  const record = optionalRecord(value, label, context);

  if (record === undefined) {
    return undefined;
  }

  return {
    label: requireString(record["label"], `${label} label`, context),
    source: requireChoice(record["source"], `${label} source`, new Set(["user", "provider"]), context) as
      | "user"
      | "provider",
  };
}

export function parsePlatformStatus(
  value: unknown,
  label: string,
  context: ParseContext,
): PlatformStatus {
  const record = requireRecord(value, label, context);
  const target = parseTarget(record["target"], `${label} target`, context);
  const status: PlatformStatus = {
    platform: requireString(record["platform"], `${label} platform`, context),
    configured: requireBoolean(record["configured"], `${label} configured`, context),
    source:
      record["source"] === null
        ? null
        : (requireChoice(record["source"], `${label} source`, SOURCE_VALUES, context) as AuthSource),
    oauthSupported: requireBoolean(
      record["oauthSupported"],
      `${label} oauthSupported`,
      context,
    ),
    readiness: requireChoice(
      record["readiness"],
      `${label} readiness`,
      READINESS_VALUES,
      context,
    ) as Readiness,
    missingFields: requirePublicFieldNames(
      record["missingFields"],
      `${label} missingFields`,
      context,
    ),
    expiresAt: requireNullableInstant(record["expiresAt"], `${label} expiresAt`, context),
    revision: requireRevision(record["revision"], `${label} revision`, context),
  };

  if (target !== undefined) {
    status.target = target;
  }

  return status;
}

export function parseAuthStatus(value: unknown, context: ParseContext): AuthStatus {
  const record = requireRecord(value, "auth status", context);
  const instance = requireRecord(record["instance"], "auth status instance", context);
  const platforms = requireRecord(record["platforms"], "auth status platforms", context);
  const parsed: Record<string, PlatformStatus> = {};

  for (const name of Object.keys(platforms)) {
    // A map key becomes an own property of the result, so only a documented
    // platform-name shape reaches the assignment.
    if (!PLATFORM_NAME_PATTERN.test(name)) {
      throw authInvalid(
        "auth status platforms contains a key this SDK does not accept",
        context,
      );
    }

    const status = parsePlatformStatus(
      platforms[name],
      "auth status platform",
      context,
    );

    if (status.platform !== name) {
      throw authIdentityError(
        "The auth status map key does not match the platform it describes.",
        context,
      );
    }

    parsed[name] = status;
  }

  return {
    instance: {
      publishingReady: requireBoolean(
        instance["publishingReady"],
        "auth status instance publishingReady",
        context,
      ),
      missingFields: requirePublicFieldNames(
        instance["missingFields"],
        "auth status instance missingFields",
        context,
      ),
    },
    platforms: parsed,
  };
}

export function parseConnectReceipt(
  value: unknown,
  context: ParseContext,
): ConnectReceipt {
  const record = requireRecord(value, "connect receipt", context);

  return {
    platform: requireString(record["platform"], "connect receipt platform", context),
    operationId: requireString(
      record["operationId"],
      "connect receipt operationId",
      context,
    ),
    url: requireString(record["url"], "connect receipt url", context),
    expiresAt: requireInstant(record["expiresAt"], "connect receipt expiresAt", context),
    expectedRevision: requireRevision(
      record["expectedRevision"],
      "connect receipt expectedRevision",
      context,
    ),
  };
}

export function parseCompleteReceipt(
  value: unknown,
  context: ParseContext,
): CompleteReceipt {
  const record = requireRecord(value, "complete receipt", context);

  if (record["stored"] !== true) {
    throw authInvalid("complete receipt stored must be true", context);
  }

  const replayed = optionalBoolean(record["replayed"], "complete receipt replayed", context);
  const receipt: CompleteReceipt = {
    platform: requireString(record["platform"], "complete receipt platform", context),
    operationId: requireString(
      record["operationId"],
      "complete receipt operationId",
      context,
    ),
    stored: true,
    revision: requireRevision(record["revision"], "complete receipt revision", context),
    configured: requireBoolean(record["configured"], "complete receipt configured", context),
    readiness: requireChoice(
      record["readiness"],
      "complete receipt readiness",
      READINESS_VALUES,
      context,
    ) as Readiness,
  };

  if (replayed !== undefined) {
    receipt.replayed = replayed;
  }

  return receipt;
}

export function parseAuthOperationStatus(
  value: unknown,
  context: ParseContext,
): AuthOperationStatus {
  const record = requireRecord(value, "auth operation", context);
  const candidate = optionalRecord(record["candidate"], "auth operation candidate", context);
  const receipt = optionalRecord(record["receipt"], "auth operation receipt", context);
  const errorCode = optionalString(record["errorCode"], "auth operation errorCode", context);
  const status: AuthOperationStatus = {
    platform: requireString(record["platform"], "auth operation platform", context),
    operationId: requireString(record["operationId"], "auth operation operationId", context),
    phase: requireChoice(
      record["phase"],
      "auth operation phase",
      PHASE_VALUES,
      context,
    ) as AuthPhase,
    expiresAt: requireInstant(record["expiresAt"], "auth operation expiresAt", context),
    expectedRevision: requireRevision(
      record["expectedRevision"],
      "auth operation expectedRevision",
      context,
    ),
    // The operation's own list names the candidate fields it still needs.
    missingFields: requirePublicFieldNames(
      record["missingFields"],
      "auth operation missingFields",
      context,
      CANDIDATE_FIELDS,
    ),
    active: parsePlatformStatus(record["active"], "auth operation active", context),
  };

  if (candidate !== undefined) {
    const target = parseTarget(candidate["target"], "auth operation candidate target", context);

    // Anything else inside `candidate` is an unknown extra and is not projected.
    status.candidate = target === undefined ? {} : { target };
  }

  if (receipt !== undefined) {
    status.receipt = parseCompleteReceipt(receipt, context);
  }

  if (errorCode !== undefined) {
    if (!AUTH_ERROR_CODES.has(errorCode)) {
      throw authInvalid(
        "auth operation errorCode is not one this SDK documents",
        context,
      );
    }

    status.errorCode = errorCode;
  }

  return status;
}

export function parseAuthSetReceipt(
  value: unknown,
  context: ParseContext,
): AuthSetReceipt {
  const record = requireRecord(value, "auth set receipt", context);

  if (record["stored"] !== true) {
    throw authInvalid("auth set receipt stored must be true", context);
  }

  return {
    platform: requireString(record["platform"], "auth set receipt platform", context),
    stored: true,
    revision: requireRevision(record["revision"], "auth set receipt revision", context),
    configured: requireBoolean(record["configured"], "auth set receipt configured", context),
    readiness: requireChoice(
      record["readiness"],
      "auth set receipt readiness",
      READINESS_VALUES,
      context,
    ) as Readiness,
  };
}

export function parseAuthRemoveReceipt(
  value: unknown,
  context: ParseContext,
): AuthRemoveReceipt {
  const record = requireRecord(value, "auth remove receipt", context);

  if (record["removed"] !== true) {
    throw authInvalid("auth remove receipt removed must be true", context);
  }

  return {
    platform: requireString(record["platform"], "auth remove receipt platform", context),
    removed: true,
    revision: requireRevision(record["revision"], "auth remove receipt revision", context),
    configured: requireBoolean(
      record["configured"],
      "auth remove receipt configured",
      context,
    ),
    readiness: requireChoice(
      record["readiness"],
      "auth remove receipt readiness",
      READINESS_VALUES,
      context,
    ) as Readiness,
  };
}

export function parseAuthRefreshReceipt(
  value: unknown,
  context: ParseContext,
): AuthRefreshReceipt {
  const record = requireRecord(value, "auth refresh receipt", context);

  if (record["refreshed"] !== true) {
    throw authInvalid("auth refresh receipt refreshed must be true", context);
  }

  return {
    platform: requireString(record["platform"], "auth refresh receipt platform", context),
    refreshed: true,
    revision: requireRevision(
      record["revision"],
      "auth refresh receipt revision",
      context,
    ),
    configured: requireBoolean(
      record["configured"],
      "auth refresh receipt configured",
      context,
    ),
    readiness: requireChoice(
      record["readiness"],
      "auth refresh receipt readiness",
      READINESS_VALUES,
      context,
    ) as Readiness,
    expiresAt: requireNullableInstant(
      record["expiresAt"],
      "auth refresh receipt expiresAt",
      context,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Argument validation: everything here runs before any request exists. */
/* ------------------------------------------------------------------ */

function argumentError(
  message: string,
  operation: SdkOperation,
  errors: ErrorSink,
): SyndrooValidationError {
  return errors.mark(new SyndrooValidationError(message, { operation }));
}

interface FieldSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/**
 * Own-property table lookup. A plain index would answer with inherited values —
 * `DIRECT_CREDENTIAL_FIELDS["constructor"]` is a function, not a field spec —
 * which would surface as a raw TypeError instead of an SDK error.
 */
function ownFieldSpec(
  table: Readonly<Record<string, FieldSpec>>,
  platform: string,
): FieldSpec | undefined {
  return Object.hasOwn(table, platform) ? table[platform] : undefined;
}

/**
 * Reads a caller object's own enumerable fields into a null-prototype record.
 *
 * A plain `{}` would route a `__proto__` key through the inherited setter, so
 * the key would vanish from `Object.keys` and a required field could be
 * satisfied by an inherited value. A null-prototype record keeps every key as
 * an own data property, which is what the checks below rely on.
 */
function ownFieldSnapshot(
  value: object,
  label: string,
  operation: SdkOperation,
  errors: ErrorSink,
): Record<string, unknown> {
  const snapshot = Object.create(null) as Record<string, unknown>;

  try {
    for (const key of Object.keys(value)) {
      snapshot[key] = (value as Record<string, unknown>)[key];
    }
  } catch {
    throw argumentError(
      `${label} could not be read; pass plain string fields.`,
      operation,
      errors,
    );
  }

  return snapshot;
}

export function validatePlatform(
  platform: unknown,
  operation: SdkOperation,
  errors: ErrorSink,
): string {
  if (typeof platform !== "string" || platform.trim().length === 0) {
    throw argumentError("A platform name is required.", operation, errors);
  }

  return platform.trim();
}

export function validateOperationId(
  id: unknown,
  operation: SdkOperation,
  errors: ErrorSink,
): string {
  if (typeof id !== "string" || id.length === 0) {
    throw argumentError("An operation id is required.", operation, errors);
  }

  return id;
}

/**
 * Every new mutation must submit a revision the caller observed. The SDK never
 * invents one, and omitting it is not a legacy fallback it will take.
 */
export function validateExpectedRevision(
  value: unknown,
  operation: SdkOperation,
  errors: ErrorSink,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw argumentError(
      "expectedRevision must be the nonnegative safe integer this caller observed.",
      operation,
      errors,
    );
  }

  return value as number;
}

/**
 * Reads the caller's credential fields into a fresh snapshot, then validates
 * the snapshot. Reading happens once, synchronously, so a later mutation of the
 * caller's object cannot change what is sent, and a throwing getter becomes a
 * controlled error with no request.
 */
export function validateCredential(
  platform: string,
  credential: unknown,
  operation: SdkOperation,
  errors: ErrorSink,
): Record<string, string> {
  const fields = ownFieldSpec(DIRECT_CREDENTIAL_FIELDS, platform);

  if (fields === undefined) {
    throw argumentError(
      "This SDK does not document direct credential fields for that platform.",
      operation,
      errors,
    );
  }

  if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
    throw argumentError(
      "credential must be an object of direct credential fields.",
      operation,
      errors,
    );
  }

  const snapshot = ownFieldSnapshot(credential, "credential", operation, errors);

  const allowed = new Set([...fields.required, ...fields.optional]);

  for (const key of Object.keys(snapshot)) {
    if (!allowed.has(key)) {
      throw argumentError(
        "credential must contain only this platform's documented direct fields.",
        operation,
        errors,
      );
    }
  }

  const parsed: Record<string, string> = {};

  for (const field of fields.required) {
    const value = snapshot[field];

    if (typeof value !== "string" || value.trim().length === 0) {
      throw argumentError(`credential ${field} is required.`, operation, errors);
    }

    parsed[field] = value;
  }

  for (const field of fields.optional) {
    const value = snapshot[field];

    if (value === undefined) {
      continue;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      throw argumentError(
        `credential ${field} must be a non-empty string when present.`,
        operation,
        errors,
      );
    }

    parsed[field] = value;
  }

  return parsed;
}

/**
 * Only the keys the selected platform documents are accepted, and the values
 * are checked here rather than at the server.
 */
export function validateCompleteTarget(
  platform: string,
  target: unknown,
  operation: SdkOperation,
  errors: ErrorSink,
): Record<string, string> | undefined {
  if (target === undefined || target === null) {
    // The server decides whether an unfinished operation still needs a target;
    // a replay of a completed one legitimately carries none.
    return undefined;
  }

  if (typeof target !== "object" || Array.isArray(target)) {
    throw argumentError("target must be an object.", operation, errors);
  }

  const snapshot = ownFieldSnapshot(target, "target", operation, errors);
  const fields = ownFieldSpec(COMPLETE_TARGET_FIELDS, platform) ?? {
    required: [],
    optional: [],
  };
  const allowed = new Set([...fields.required, ...fields.optional]);

  for (const key of Object.keys(snapshot)) {
    if (!allowed.has(key)) {
      throw argumentError(
        "target must contain only this platform's documented keys.",
        operation,
        errors,
      );
    }
  }

  const parsed: Record<string, string> = {};

  for (const field of [...fields.required, ...fields.optional]) {
    const value = snapshot[field];

    if (value === undefined) {
      if (fields.required.includes(field)) {
        throw argumentError(`target ${field} is required.`, operation, errors);
      }

      continue;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      throw argumentError(
        `target ${field} must be a non-empty string when present.`,
        operation,
        errors,
      );
    }

    if (field === "author" && !LINKEDIN_AUTHOR_PATTERN.test(value)) {
      throw argumentError(
        "target author must be a LinkedIn person or organization URN.",
        operation,
        errors,
      );
    }

    if (field === "api_version" && !LINKEDIN_VERSION_PATTERN.test(value)) {
      throw argumentError(
        "target api_version must be a supported YYYYMM LinkedIn version.",
        operation,
        errors,
      );
    }

    if (field === "blog" && !BLOG_PATTERN.test(value)) {
      throw argumentError(
        "target blog must be a bare blog name without spaces or slashes.",
        operation,
        errors,
      );
    }

    parsed[field] = value;
  }

  return Object.keys(parsed).length === 0 ? undefined : parsed;
}
