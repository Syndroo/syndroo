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
}

export class SyndrooError<
  Code extends SyndrooErrorCode = SyndrooErrorCode,
> extends Error {
  readonly code: Code;
  readonly requestMayHaveBeenApplied: boolean;

  constructor(
    message: string,
    init: SyndrooErrorInit & { code: Code },
  ) {
    super(message, { cause: init.cause });
    this.name = "SyndrooError";
    this.code = init.code;
    this.requestMayHaveBeenApplied = init.requestMayHaveBeenApplied ?? false;
  }
}

/** The client configuration itself is unusable, so no request was sent. */
export class SyndrooConfigError extends SyndrooError<"CONFIG"> {
  constructor(message: string) {
    super(message, { code: "CONFIG" });
    this.name = "SyndrooConfigError";
  }
}

/** The caller's argument cannot become a valid Syndroo request. */
export class SyndrooValidationError extends SyndrooError<"VALIDATION"> {
  constructor(message: string) {
    super(message, { code: "VALIDATION" });
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
    },
  ) {
    super(message, { code: "WAIT_TIMEOUT", requestMayHaveBeenApplied: false });
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
 * Internal helper for bounded diagnostics. Error messages and response
 * previews must never grow with the size of an untrusted body.
 */
export function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[${value.length - limit} more characters]`;
}
