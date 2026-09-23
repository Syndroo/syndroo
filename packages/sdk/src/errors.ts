/**
 * Typed error hierarchy for the public Syndroo SDK.
 *
 * Every failure the SDK raises is a `SyndrooError`, so callers can narrow on
 * one base class and still classify the outcome precisely. The
 * `requestMayHaveBeenApplied` flag is the state that decides whether a resend
 * is safe: it is true whenever a write may already have reached Syndroo, which
 * is exactly the case where retrying with a new idempotency key could create a
 * second post.
 */

import type { PostDetail } from "./types.js";

/**
 * The fixed SDK operation a call performs. It identifies the call, never the
 * caller's data: no platform, post id, operation id, or URL belongs in it.
 */
export type SdkOperation =
  | "health"
  | "posts.create"
  | "posts.get"
  | "posts.list"
  | "posts.wait"
  | "auth.status"
  | "auth.set"
  | "auth.connect"
  | "auth.operation"
  | "auth.complete"
  | "auth.refresh"
  | "auth.remove"
  | "diagnostics";

/**
 * Operations that may already have changed server state when they fail. A read
 * never did, so it always reports `requestMayHaveBeenApplied: false`.
 */
const WRITE_OPERATIONS: ReadonlySet<SdkOperation> = new Set<SdkOperation>([
  "posts.create",
  "auth.set",
  "auth.connect",
  "auth.complete",
  "auth.refresh",
  "auth.remove",
]);

export function isWriteOperation(operation: SdkOperation): boolean {
  return WRITE_OPERATIONS.has(operation);
}

/**
 * The closed list of server codes the SDK is willing to echo. Every entry is a
 * documented public code: the request/route/body codes, the auth and post
 * codes, the rate-limit/service codes, the public publication error codes, and
 * the 0.5.0 auth/storage codes. Anything else becomes `HTTP_<status>`; the SDK
 * never repeats arbitrary text merely because the server sent it.
 */
const PUBLIC_SERVER_CODES: ReadonlySet<string> = new Set([
  "INVALID_REQUEST",
  "INVALID_JSON",
  "UNSUPPORTED_MEDIA_TYPE",
  "BODY_TOO_LARGE",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "AUTH_CONFLICT",
  "AUTH_IN_PROGRESS",
  "POST_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_CONTENT",
  "RATE_LIMITED",
  "RATE_LIMIT",
  "PLATFORM_NOT_CONFIGURED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
  "INSTANCE_NOT_READY",
  "STORE_UNAVAILABLE",
  "AUTH",
  "PROVIDER_ERROR",
  "PROVIDER_UNAVAILABLE",
  "NETWORK",
  "UNKNOWN",
]);

/** Codes the SDK itself generates, so they are fixed and safe to report. */
const SDK_GENERATED_CODES: ReadonlySet<string> = new Set([
  "REDIRECT_NOT_FOLLOWED",
]);

/** An allowlisted server code, or the status-derived fallback. */
export function publicErrorCode(
  code: string | undefined,
  status: number,
): string {
  if (
    code !== undefined &&
    (PUBLIC_SERVER_CODES.has(code) || SDK_GENERATED_CODES.has(code))
  ) {
    return code;
  }

  return `HTTP_${status}`;
}

/**
 * Runtime network codes worth reporting: the Node/undici connection failures
 * and TLS verdicts a caller can act on. Everything else stays unreported.
 */
const PUBLIC_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EADDRNOTAVAIL",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "UND_ERR_RESPONSE_STATUS_CODE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

/** An allowlisted runtime network code, or `undefined`. */
export function publicNetworkCode(value: unknown): string | undefined {
  if (typeof value === "string" && PUBLIC_NETWORK_CODES.has(value)) {
    return value;
  }

  return undefined;
}

/**
 * Reads one property without trusting the object. A hostile or injected error
 * may expose throwing getters, and that must not replace the SDK's own
 * classification of the failure.
 */
export function safeProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export type SyndrooErrorCode =
  | "CONFIG"
  | "VALIDATION"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "WAIT_TIMEOUT"
  | (string & {});

export interface SyndrooErrorInit {
  cause?: unknown | undefined;
  requestMayHaveBeenApplied?: boolean | undefined;
  /**
   * The fixed SDK operation that failed. Optional so existing callers can keep
   * constructing these errors themselves.
   */
  operation?: SdkOperation | undefined;
}

export class SyndrooError<
  Code extends SyndrooErrorCode = SyndrooErrorCode,
> extends Error {
  readonly code: Code;
  readonly requestMayHaveBeenApplied: boolean;
  readonly operation?: SdkOperation;

  constructor(
    message: string,
    init: SyndrooErrorInit & { code: Code },
  ) {
    super(message, { cause: init.cause });
    this.name = "SyndrooError";
    this.code = init.code;
    this.requestMayHaveBeenApplied = init.requestMayHaveBeenApplied ?? false;

    if (init.operation !== undefined) {
      this.operation = init.operation;
    }
  }
}

/** The client configuration itself is unusable, so no request was sent. */
export class SyndrooConfigError extends SyndrooError<"CONFIG"> {
  constructor(
    message: string,
    init: { operation?: SdkOperation | undefined } = {},
  ) {
    super(message, { code: "CONFIG", operation: init.operation });
    this.name = "SyndrooConfigError";
  }
}

/** The caller's argument cannot become a valid Syndroo request. */
export class SyndrooValidationError extends SyndrooError<"VALIDATION"> {
  constructor(
    message: string,
    init: { operation?: SdkOperation | undefined } = {},
  ) {
    super(message, { code: "VALIDATION", operation: init.operation });
    this.name = "SyndrooValidationError";
  }
}

/** The caller aborted through an AbortSignal. */
export class SyndrooAbortError extends SyndrooError<"ABORTED"> {
  constructor(message: string, init: SyndrooErrorInit = {}) {
    super(message, {
      code: "ABORTED",
      cause: init.cause,
      requestMayHaveBeenApplied: init.requestMayHaveBeenApplied,
      operation: init.operation,
    });
    this.name = "SyndrooAbortError";
  }
}

/** The configured deadline elapsed before the response was received. */
export class SyndrooTimeoutError extends SyndrooError<"TIMEOUT"> {
  readonly timeoutMs: number;

  constructor(
    message: string,
    init: SyndrooErrorInit & { timeoutMs: number },
  ) {
    super(message, {
      code: "TIMEOUT",
      cause: init.cause,
      requestMayHaveBeenApplied: init.requestMayHaveBeenApplied,
      operation: init.operation,
    });
    this.name = "SyndrooTimeoutError";
    this.timeoutMs = init.timeoutMs;
  }
}

/**
 * The request never produced an HTTP response. `networkCode` carries the
 * runtime's error code, such as `ECONNREFUSED`, when one is available.
 */
export class SyndrooNetworkError extends SyndrooError<"NETWORK"> {
  readonly networkCode?: string;

  constructor(
    message: string,
    init: SyndrooErrorInit & { networkCode?: string | undefined },
  ) {
    super(message, {
      code: "NETWORK",
      cause: init.cause,
      requestMayHaveBeenApplied: init.requestMayHaveBeenApplied,
      operation: init.operation,
    });
    this.name = "SyndrooNetworkError";

    if (init.networkCode !== undefined) {
      this.networkCode = init.networkCode;
    }
  }
}

/**
 * Syndroo answered, but the answer is not the documented JSON contract: a
 * non-JSON body, a missing required field, or a body above the configured
 * size limit. The outcome of a write is never inferred from a bad response.
 */
export class SyndrooResponseError extends SyndrooError<"INVALID_RESPONSE"> {
  readonly status?: number;
  readonly preview?: string;

  constructor(
    message: string,
    init: SyndrooErrorInit & {
      status?: number | undefined;
      preview?: string | undefined;
    } = {},
  ) {
    super(message, {
      code: "INVALID_RESPONSE",
      cause: init.cause,
      requestMayHaveBeenApplied: init.requestMayHaveBeenApplied,
      operation: init.operation,
    });
    this.name = "SyndrooResponseError";

    if (init.status !== undefined) {
      this.status = init.status;
    }

    if (init.preview !== undefined) {
      this.preview = init.preview;
    }
  }
}

/**
 * Syndroo rejected the request with a documented error envelope. `code` is the
 * server's code such as `UNAUTHORIZED`, `POST_NOT_FOUND`,
 * `IDEMPOTENCY_CONFLICT`, or `PLATFORM_NOT_CONFIGURED`, and `HTTP_<status>`
 * when the body did not carry one.
 */
export class SyndrooApiError extends SyndrooError {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    init: SyndrooErrorInit & {
      code: SyndrooErrorCode;
      status: number;
      retryAfterMs?: number | undefined;
    },
  ) {
    super(message, {
      code: init.code,
      cause: init.cause,
      requestMayHaveBeenApplied: init.requestMayHaveBeenApplied,
      operation: init.operation,
    });
    this.name = "SyndrooApiError";
    this.status = init.status;

    if (init.retryAfterMs !== undefined) {
      this.retryAfterMs = init.retryAfterMs;
    }
  }

  /** Syndroo or an intermediary asked the client to slow down. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** `posts.wait` reached its deadline before the post became terminal. */
export class SyndrooWaitTimeoutError extends SyndrooError<"WAIT_TIMEOUT"> {
  readonly postId: string;
  readonly timeoutMs: number;
  readonly lastStatus?: string;
  readonly lastPost?: PostDetail;
  readonly lastError?: SyndrooError;

  constructor(
    message: string,
    init: {
      postId: string;
      timeoutMs: number;
      lastStatus?: string | undefined;
      lastPost?: PostDetail | undefined;
      lastError?: SyndrooError | undefined;
      operation?: SdkOperation | undefined;
    },
  ) {
    super(message, {
      code: "WAIT_TIMEOUT",
      requestMayHaveBeenApplied: false,
      operation: init.operation,
    });
    this.name = "SyndrooWaitTimeoutError";
    this.postId = init.postId;
    this.timeoutMs = init.timeoutMs;

    if (init.lastStatus !== undefined) {
      this.lastStatus = init.lastStatus;
    }

    if (init.lastPost !== undefined) {
      this.lastPost = init.lastPost;
    }

    if (init.lastError !== undefined) {
      this.lastError = init.lastError;
    }
  }
}

export function isSyndrooError(value: unknown): value is SyndrooError {
  return value instanceof SyndrooError;
}

/**
 * Identity marker for the errors one SDK call built.
 *
 * `instanceof` proves nothing about provenance: the error classes are public,
 * so a hostile or injected `fetch`, body, or abort signal can hand back an
 * object of the same class — even one the SDK built earlier and the caller then
 * mutated. Each call creates its own sink and marks only the errors it
 * constructs, so a sink can never contain an error from outside that call.
 */
export interface ErrorSink {
  /** Registers an error this call built, and returns it for `throw`/`return`. */
  mark<T extends SyndrooError>(error: T): T;
  /** True only for errors marked during this call. */
  has(value: unknown): value is SyndrooError;
}

export function createErrorSink(): ErrorSink {
  const built = new WeakSet<object>();

  return {
    mark<T extends SyndrooError>(error: T): T {
      built.add(error);
      return error;
    },
    has(value: unknown): value is SyndrooError {
      return typeof value === "object" && value !== null && built.has(value);
    },
  };
}

/**
 * Internal helper for bounded diagnostics. Error messages and response
 * previews must never grow with the size of an untrusted body.
 */
export function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[${value.length - limit} more characters]`;
}
