/**
 * Fixed, message-free failures for the portable credential use cases.
 *
 * Every value here is a closed enum owned by this repository. A failure that
 * crosses this boundary therefore carries only a documented code and reason:
 * no provider text, no storage cause, no credential value and no injected
 * object — not even a forged instance of `AuthUseCaseError`. Runtime wiring maps
 * the code to its HTTP status (`INVALID_REQUEST` -> 400,
 * `AUTH_CONFLICT`/`AUTH_IN_PROGRESS` -> 409, `INSTANCE_NOT_READY` /
 * `STORE_UNAVAILABLE` -> controlled 503).
 *
 * Input validation, decryption of caller bytes and the direct CAS are the
 * current consumers. A wiring defect such as a clock that does not return a
 * canonical instant still travels as `InvalidContractInputError`, which the
 * application already classifies as a contract violation rather than caller
 * input.
 *
 * `NOT_FOUND` and `PROVIDER_ERROR` plus the OAuth-specific reasons exist for the
 * portable authorization flow (connect, callback, operation read). They are
 * additive closed entries: no existing code, reason or mapping changed.
 */

export type AuthErrorCode =
  | "INVALID_REQUEST"
  | "AUTH_CONFLICT"
  | "AUTH_IN_PROGRESS"
  | "INSTANCE_NOT_READY"
  | "STORE_UNAVAILABLE"
  | "NOT_FOUND"
  | "PROVIDER_ERROR";

/**
 * Fixed reasons a caller may see.
 *
 * `platform` also covers a platform whose strategy is not installed, so the
 * runtime can keep its existing platform-not-configured response.
 */
export type AuthErrorReason =
  | "platform"
  | "expected_revision"
  | "credential_body"
  | "revision_mismatch"
  | "unexpected_result"
  | "payload_generation_overflow"
  | "cipher_unavailable"
  | "store_unavailable"
  | "corrupt_record"
  | "unavailable"
  | "callback"
  | "oauth_unsupported"
  | "invalid_driver_response"
  | "operation_not_found"
  | "operation_phase"
  | "operation_expired"
  | "config_changed"
  | "request_token_mismatch"
  | "request_secret_unavailable"
  | "provider_error"
  | "candidate_invalid"
  | "candidate_expired"
  | "target"
  | "target_required"
  | "no_refresh_payload"
  | "reconnect_required"
  | "lease_held"
  | "lease_mismatch";

const AUTH_ERROR_CODES: readonly AuthErrorCode[] = Object.freeze([
  "INVALID_REQUEST",
  "AUTH_CONFLICT",
  "AUTH_IN_PROGRESS",
  "INSTANCE_NOT_READY",
  "STORE_UNAVAILABLE",
  "NOT_FOUND",
  "PROVIDER_ERROR",
]);

const AUTH_ERROR_REASONS: readonly AuthErrorReason[] = Object.freeze([
  "platform",
  "expected_revision",
  "credential_body",
  "revision_mismatch",
  "unexpected_result",
  "payload_generation_overflow",
  "cipher_unavailable",
  "store_unavailable",
  "corrupt_record",
  "unavailable",
  "callback",
  "oauth_unsupported",
  "invalid_driver_response",
  "operation_not_found",
  "operation_phase",
  "operation_expired",
  "config_changed",
  "request_token_mismatch",
  "request_secret_unavailable",
  "provider_error",
  "candidate_invalid",
  "candidate_expired",
  "target",
  "target_required",
  "no_refresh_payload",
  "reconnect_required",
  "lease_held",
  "lease_mismatch",
]);

const CODE_MESSAGES: Readonly<Record<AuthErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "the auth request is not structurally valid",
  AUTH_CONFLICT: "the credential slot changed since it was observed",
  AUTH_IN_PROGRESS: "another credential operation is already in progress",
  INSTANCE_NOT_READY: "the publishing instance cannot perform credential writes",
  STORE_UNAVAILABLE: "credential storage is unavailable",
  NOT_FOUND: "no matching authorization record was found",
  PROVIDER_ERROR: "the authorization provider could not complete the request",
});

/** A fixed, map-ready auth failure. The message never interpolates a value. */
export class AuthUseCaseError extends Error {
  readonly code: AuthErrorCode;
  readonly reason: AuthErrorReason | null;

  public constructor(code: AuthErrorCode, reason: AuthErrorReason | null = null) {
    super(CODE_MESSAGES[code]);
    this.name = "AuthUseCaseError";
    this.code = code;
    this.reason = reason;
  }
}

function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && (AUTH_ERROR_CODES as readonly string[]).includes(value);
}

function isAuthErrorReason(value: unknown): value is AuthErrorReason {
  return typeof value === "string" && (AUTH_ERROR_REASONS as readonly string[]).includes(value);
}

/**
 * Rebuild a documented failure, or return null for anything else.
 *
 * An injected object may claim to be one of ours, so only the two allowlisted
 * enums survive and the instance is rebuilt with our own message; the original
 * message, cause and extra fields are dropped.
 *
 * Nothing about the candidate is trusted, not even `instanceof`: a proxy
 * prototype trap or a forged instance with a throwing `code`/`reason` getter
 * would otherwise turn an inspection into a raw escape. Every read happens
 * inside this guard, and the function never throws.
 */
export function preserveAuthFailure(error: unknown): AuthUseCaseError | null {
  try {
    if (!(error instanceof AuthUseCaseError)) {
      return null;
    }
    const code: unknown = error.code;
    const reason: unknown = error.reason;
    if (!isAuthErrorCode(code)) {
      return null;
    }
    return new AuthUseCaseError(code, isAuthErrorReason(reason) ? reason : null);
  } catch {
    return null;
  }
}

/**
 * Classify an injected failure for one boundary.
 *
 * A documented failure keeps its code and reason; every other failure — a
 * provider error, a storage cause, a value with a secret in its message — is
 * replaced by the caller's fixed fallback.
 */
export function authFailure(
  error: unknown,
  fallbackCode: AuthErrorCode,
  fallbackReason: AuthErrorReason | null,
): AuthUseCaseError {
  return preserveAuthFailure(error) ?? new AuthUseCaseError(fallbackCode, fallbackReason);
}

/** Fixed, allowlisted readiness projection for a caller-supplied status. */
export function safeReadiness(
  value: unknown,
): "ready" | "missing_credentials" | "needs_configuration" | "expired" | "reconnect_required" | "unavailable" {
  switch (value) {
    case "ready":
    case "missing_credentials":
    case "needs_configuration":
    case "expired":
    case "reconnect_required":
    case "unavailable":
      return value;
    default:
      return "unavailable";
  }
}
