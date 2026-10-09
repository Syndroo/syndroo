/**
 * Error surface of `@syndroo/sdk`.
 *
 * Every error the SDK raises carries a stable `code` and a fixed message. The
 * message never contains a base URL, a path, an idempotency key, a bearer token
 * or any part of a server response, because SDK errors reach logs. The only
 * server-authored data that can appear is `serverError`, and only after the
 * envelope that carried it passed the generated wire validator.
 *
 * A validated envelope is not enough on its own: the wire schema legitimately
 * allows arbitrary `code`/`message` strings and tolerates extra fields, so the
 * server object is never stored by reference. `projectServerError` copies it
 * onto a fixed shape - an allowlisted code, a static message and bounded
 * `details` values - so no server-authored text can reach a log through
 * `JSON.stringify`, `util.inspect` or a stack trace.
 */

import type { SafeError } from "./types.js";

/**
 * Protocol error codes the server may report verbatim (the stable set from the
 * shared blueprint). A code outside this set is never retained.
 */
const SERVER_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "INVALID_INPUT",
  "BODY_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "DUPLICATE_TARGET",
  "CONNECTION_IDENTITY_CHANGED",
  "CONNECTION_CAPACITY",
  "PROVIDER_TRUST_REQUIRED",
  "PROVIDER_INVALID",
  "PROVIDER_UNAVAILABLE",
  "STALE_INTENT",
  "STALE_BINDING",
  "APPROVAL_INVALID",
  "APPROVAL_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_IN_PROGRESS",
  "RETRY_INELIGIBLE",
  "CONNECT_SESSION_EXPIRED",
  "CONNECT_STEP_CONFLICT",
  "CONNECT_STEP_UNKNOWN",
  "STATE_RECOVERY_REQUIRED",
  "DURABILITY_ERROR",
]);

/** Static text kept in place of every server-authored message. */
const SERVER_ERROR_MESSAGE = "the server rejected the request";

/** Placeholder for a server code the SDK does not recognize. */
const UNKNOWN_SERVER_ERROR_CODE = "UNKNOWN_ERROR";

/** A dotted path with optional array indices, e.g. `targets[0].options.visibility`. */
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,6}\])*$/;
/**
 * A Syndroo operation id. Core mints every id as `<prefix>_<base64url>` (for
 * example `op_2f8c...`), so the shape - a short lowercase prefix, then a
 * base64url token - is checkable without importing Core. A string that does not
 * have it is not an id the SDK will echo back.
 */
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9]{0,7}_[A-Za-z0-9_-]{1,118}$/;
/** RFC 3339 date-time, the `IsoTime` shape the wire schema uses. */
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function projectDetails(raw: unknown): SafeError["details"] | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const details: { field?: string; operationId?: string; retryAt?: string } = {};
  const field = source["field"];
  if (typeof field === "string" && field.length <= 256 && FIELD_PATH_PATTERN.test(field)) {
    details.field = field;
  }
  const operationId = source["operationId"];
  if (typeof operationId === "string" && OPERATION_ID_PATTERN.test(operationId)) {
    details.operationId = operationId;
  }
  const retryAt = source["retryAt"];
  if (typeof retryAt === "string" && ISO_TIME_PATTERN.test(retryAt)) {
    details.retryAt = retryAt;
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

/**
 * Project a server-authored error onto a fixed, allowlisted shape.
 *
 * Only three fields survive, each of them validated: an allowlisted `code` (an
 * unrecognized code becomes `UNKNOWN_ERROR`), a static `message`, and `details`
 * rebuilt from scratch so unknown keys, wrong types and malformed values are
 * dropped. Nothing is copied by reference, so mutating the original object
 * afterwards cannot change what an error reports.
 */
export function projectServerError(raw: unknown): SafeError | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const rawCode = source["code"];
  const code =
    typeof rawCode === "string" && SERVER_ERROR_CODES.has(rawCode)
      ? rawCode
      : UNKNOWN_SERVER_ERROR_CODE;
  const error: SafeError = { code, message: SERVER_ERROR_MESSAGE };
  const details = projectDetails(source["details"]);
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

/** Stable, branchable error codes. Adding one is an API decision. */
export type SyndrooErrorCode =
  | "INVALID_ARGUMENT"
  | "INSECURE_BASE_URL"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_NOT_ALLOWED"
  | "TRANSPORT"
  | "HTTP_ERROR"
  | "PROTOCOL"
  | "TIMEOUT"
  | "ABORTED"
  | "WAIT_TIMEOUT"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED";

/** Fixed messages. Nothing here is interpolated from input or from a response. */
const MESSAGES: Readonly<Record<SyndrooErrorCode, string>> = Object.freeze({
  INVALID_ARGUMENT: "the SDK call was given an argument outside its documented bounds",
  INSECURE_BASE_URL: "the base URL is not an acceptable Syndroo endpoint",
  INVALID_REQUEST: "the request does not match the Syndroo wire protocol",
  INVALID_RESPONSE: "the server response does not match the Syndroo wire protocol",
  RESPONSE_TOO_LARGE: "the server response exceeded the protocol size bound",
  REDIRECT_NOT_ALLOWED: "the server answered with a redirect, which the SDK never follows",
  TRANSPORT: "the request could not be completed at the transport layer",
  HTTP_ERROR: "the server answered with an unexpected HTTP status",
  PROTOCOL: "the server rejected the request",
  TIMEOUT: "the request deadline elapsed before a response arrived",
  ABORTED: "the call was cancelled locally",
  WAIT_TIMEOUT: "the wait deadline elapsed before the execution round completed",
  CONFIRMATION_REQUIRED: "the operation is waiting for explicit confirmation",
  CONFIRMATION_EXPIRED: "the prepared operation's confirmation window has expired",
});

export type SyndrooErrorInit = {
  /** HTTP status, when the error came from a response. Never a response body. */
  status?: number;
  /**
   * `SafeError` from an `ok:false` envelope, or any object meant to stand in
   * for one. It is projected onto the allowlisted shape, never stored as-is.
   */
  serverError?: SafeError;
  /**
   * Whether the SDK considers a same-key transport retry safe for this failure.
   * Defaults to true for a bare transport failure and false otherwise.
   */
  retryable?: boolean;
};

/**
 * One error type for transport, protocol and local-cancellation failures.
 *
 * `retryable` describes the SDK's own transport-retry decision for this failure
 * and is never advice to retry content: an `unknown` business outcome is a
 * successful protocol call, not an error, and is never auto-retried.
 */
export class SyndrooError extends Error {
  readonly code: SyndrooErrorCode;
  readonly status?: number;
  readonly serverError?: SafeError;
  readonly retryable: boolean;

  constructor(code: SyndrooErrorCode, init: SyndrooErrorInit = {}) {
    super(MESSAGES[code]);
    this.name = "SyndrooError";
    this.code = code;
    if (init.status !== undefined) {
      this.status = init.status;
    }
    if (init.serverError !== undefined) {
      const projected = projectServerError(init.serverError);
      if (projected !== undefined) {
        this.serverError = projected;
      }
    }
    this.retryable = init.retryable ?? code === "TRANSPORT";
  }
}


export function isSyndrooError(value: unknown): value is SyndrooError {
  return value instanceof SyndrooError;
}
