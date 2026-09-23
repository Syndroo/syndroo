/**
 * The single HTTP transport used by the SDK.
 *
 * Invariants this module enforces for every request:
 *
 * - exactly one network request per call; the SDK never retries a write,
 *   because a retry without a stable idempotency key can duplicate a post;
 * - redirects are not followed, so the `Authorization` header can never reach
 *   a redirect target;
 * - every request is bounded by a finite deadline;
 * - the response body is read with a size limit, so an oversized or hostile
 *   response cannot exhaust the caller's memory;
 * - no logging, so credentials and content never reach stdout or stderr.
 */

import {
  createErrorSink,
  isWriteOperation,
  publicErrorCode,
  publicNetworkCode,
  safeProperty,
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooConfigError,
  SyndrooError,
  SyndrooNetworkError,
  SyndrooResponseError,
  SyndrooTimeoutError,
  SyndrooValidationError,
  type ErrorSink,
  type SdkOperation,
} from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MIN_MAX_RESPONSE_BYTES = 1024;
/**
 * Node's timers take a signed 32-bit delay. A larger value is not rejected by
 * Node: it clamps the delay to 1ms and prints a `TimeoutOverflowWarning`, which
 * would silently turn a long deadline into an immediate one. Every SDK
 * duration is bounded by this value so the deadline reported is the deadline
 * kept.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface TransportRequest {
  method: "GET" | "POST" | "DELETE";
  /**
   * The fixed SDK operation. It drives error context and recovery advice and is
   * never built from caller data.
   */
  operation: SdkOperation;
  path: string;
  query?: Record<string, string> | undefined;
  json?: unknown;
  idempotencyKey?: string | undefined;
  /** `false` for unauthenticated endpoints such as `/health`. */
  authenticated?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

export async function sendRequest(
  config: TransportConfig,
  request: TransportRequest,
  /**
   * The per-call identity marker. Pass the caller's sink when the caller has to
   * recognize the errors of this call; otherwise a private one is used.
   */
  errors: ErrorSink = createErrorSink(),
): Promise<TransportResponse> {
  const operation = request.operation;
  const isWrite = isWriteOperation(operation);
  const timeoutMs = request.timeoutMs ?? config.timeoutMs;
  const userSignal = request.signal;
  const invalidDuration = durationError(timeoutMs, "timeoutMs");
  let url: URL;

  try {
    url = buildUrl(config.baseUrl, request.path, request.query);
  } catch {
    // A raw URL error would echo the base URL; report the shape instead.
    throw errors.mark(
      new SyndrooConfigError(
        "The request URL could not be built from baseUrl and the SDK request path.",
        { operation },
      ),
    );
  }

  // The bound is checked where the timer is created, before any request exists.
  if (invalidDuration !== undefined) {
    throw errors.mark(new SyndrooConfigError(invalidDuration, { operation }));
  }

  if (userSignal?.aborted === true) {
    throw errors.mark(
      new SyndrooAbortError(
        "The request was aborted before it was sent, so nothing reached Syndroo.",
        { operation, requestMayHaveBeenApplied: false },
      ),
    );
  }

  let headers: Headers;

  try {
    headers = new Headers({ accept: "application/json" });

    if (request.authenticated !== false) {
      headers.set("authorization", `Bearer ${config.apiKey}`);
    }

    if (request.idempotencyKey !== undefined) {
      headers.set("idempotency-key", request.idempotencyKey);
    }

    if (request.json !== undefined) {
      headers.set("content-type", "application/json");
    }
  } catch {
    // A raw Headers error repeats the offending value, which is the API key.
    throw errors.mark(
      new SyndrooConfigError(
        "The request headers could not be built from the configured credentials.",
        { operation },
      ),
    );
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.json !== undefined) {
    try {
      init.body = JSON.stringify(request.json);
    } catch {
      throw errors.mark(
        new SyndrooValidationError(
          "The request body could not be serialized as JSON.",
          { operation },
        ),
      );
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  let handle: ReturnType<typeof setTimeout> | undefined;

  /**
   * The deadline is a race, not a hope: an injected or hostile fetch that
   * ignores AbortSignal still cannot hold the call past its budget. The timer
   * stays referenced so a standalone async operation is not abandoned before
   * it settles; `finally` clears it on every path.
   */
  const deadline = new Promise<"deadline">((resolve) => {
    handle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("deadline");
    }, timeoutMs);
  });

  init.signal = controller.signal;

  let onAbort: (() => void) | undefined;

  const aborted = new Promise<"abort">((resolve) => {
    onAbort = () => {
      controller.abort();
      resolve("abort");
    };

    userSignal?.addEventListener("abort", onAbort, { once: true });
  });

  /**
   * The SDK's own error for a failure, built from fixed text and allowlisted
   * codes. The raw failure is never kept: it can carry a URL, a provider
   * message, or an abort reason.
   */
  const failure = (error: unknown): SyndrooError => {
    if (timedOut) {
      return errors.mark(
        new SyndrooTimeoutError(
          timeoutMessage(operation, isWrite, timeoutMs),
          { operation, timeoutMs, requestMayHaveBeenApplied: isWrite },
        ),
      );
    }

    if (userSignal?.aborted === true) {
      return errors.mark(
        new SyndrooAbortError(abortMessage(operation, isWrite), {
          operation,
          requestMayHaveBeenApplied: isWrite,
        }),
      );
    }

    const networkCode = networkCodeOf(error);

    return errors.mark(
      new SyndrooNetworkError(
        networkMessage(operation, isWrite, networkCode),
        { operation, networkCode, requestMayHaveBeenApplied: isWrite },
      ),
    );
  };

  const work = (async (): Promise<TransportResponse> => {
    let response: Response;

    try {
      response = await globalThis.fetch(url, init);
    } catch (error) {
      throw failure(error);
    }

    // A response that arrives after the deadline or a caller abort is late:
    // nothing will read it, so it is disposed without touching the body.
    if (timedOut || userSignal?.aborted === true) {
      disposeBody(response);
      throw failure(undefined);
    }

    try {
      if (isRedirectResponse(response)) {
        // Nothing further travels on this connection, and the body is refused.
        controller.abort();
        disposeBody(response);
        throw errors.mark(
          new SyndrooApiError(redirectMessage(response.status), {
            code: "REDIRECT_NOT_FOLLOWED",
            status: response.status,
            operation,
            requestMayHaveBeenApplied: false,
          }),
        );
      }

      const text = await readBody(
        response,
        config.maxResponseBytes,
        controller.signal,
        operation,
        errors,
        () => failure(undefined),
        () => controller.abort(),
      );

      if (!response.ok) {
        throw apiError(response, text, operation, errors);
      }

      return {
        status: response.status,
        body: parseJson(text, response.status, operation, errors),
      };
    } catch (error) {
      if (errors.has(error)) {
        throw error;
      }

      throw failure(error);
    }
  })();

  try {
    const outcome = await Promise.race([
      work.then((result) => ({ kind: "response" as const, result })),
      deadline,
      aborted,
    ]);

    if (outcome === "abort") {
      throw errors.mark(
        new SyndrooAbortError(abortMessage(operation, isWrite), {
          operation,
          requestMayHaveBeenApplied: isWrite,
        }),
      );
    }

    if (outcome === "deadline") {
      throw errors.mark(
        new SyndrooTimeoutError(
          timeoutMessage(operation, isWrite, timeoutMs),
          { operation, timeoutMs, requestMayHaveBeenApplied: isWrite },
        ),
      );
    }

    return outcome.result;
  } finally {
    if (handle !== undefined) {
      clearTimeout(handle);
    }

    if (onAbort !== undefined) {
      userSignal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The shared bound for every caller-supplied duration: request deadlines, wait
 * budgets, and poll intervals. Returns the message to raise for an unusable
 * value, or `undefined` when the value is usable. Fractional millisecond
 * values are kept as given.
 */
export function durationError(value: number, label: string): string | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return `${label} must be a positive, finite number of milliseconds.`;
  }

  if (value > MAX_TIMEOUT_MS) {
    return (
      `${label} must be at most ${MAX_TIMEOUT_MS} milliseconds, the longest ` +
      "delay Node.js timers honor without clamping it to 1ms."
    );
  }

  return undefined;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string> | undefined,
): URL {
  const url = new URL(`${baseUrl}${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  return url;
}

function isRedirectResponse(response: Response): boolean {
  if (response.type === "opaqueredirect") {
    return true;
  }

  return response.status >= 300 && response.status < 400;
}

/**
 * Releases a body nobody is going to read. Cancellation is abandoned work, so
 * it is never awaited and its rejection is handled here rather than surfacing
 * later as an unhandled rejection.
 */
function disposeBody(response: Response): void {
  try {
    const body = response.body;

    if (body === null) {
      return;
    }

    void body.cancel("The request ended before the body was read").catch(() => undefined);
  } catch {
    // A locked or already-errored body has nothing left to dispose.
  }
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  operation: SdkOperation,
  errors: ErrorSink,
  lateFailure: () => SyndrooError,
  abortTransport: () => void,
): Promise<string> {
  const body = response.body;

  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let stop: (() => void) | undefined;

  /**
   * Ends the transport and the stream together. Cancellation is abandoned work:
   * it is never awaited and its rejection is handled here, so a reader whose
   * `cancel()` hangs cannot hold the call.
   */
  const cancel = (): void => {
    abortTransport();

    try {
      void reader.cancel("The request ended before the body was read").catch(() => undefined);
    } catch {
      // Already cancelled or errored.
    }
  };

  // A deadline or abort that already fired must not start a read: an abort
  // listener added afterwards would never run.
  if (signal.aborted) {
    cancel();
    throw lateFailure();
  }

  /** Resolves when the request ends, even if the reader never settles. */
  const stopped = new Promise<"stopped">((resolve) => {
    stop = () => {
      resolve("stopped");
    };
  });

  const onAbort = (): void => {
    cancel();
    stop?.();
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      let outcome: { done: boolean; value?: Uint8Array | undefined } | "stopped";

      try {
        outcome = await Promise.race([reader.read(), stopped]);
      } catch (error) {
        cancel();
        throw error;
      }

      // The deadline or abort won the race, so this read is abandoned.
      if (outcome === "stopped") {
        throw lateFailure();
      }

      const { done, value } = outcome;

      if (done) {
        break;
      }

      if (value === undefined) {
        continue;
      }

      length += value.byteLength;

      if (length > maxBytes) {
        cancel();
        throw errors.mark(
          new SyndrooResponseError(
            `Syndroo returned a response larger than the configured limit of ${maxBytes} bytes. ` +
              "Raise maxResponseBytes only for a trusted deployment.",
            {
              status: response.status,
              operation,
              requestMayHaveBeenApplied: mayHaveBeenApplied(
                response.status,
                isWriteOperation(operation),
              ),
            },
          ),
        );
      }

      // Copy the chunk: the next read may reuse the buffer behind this view.
      chunks.push(value.slice());
    }
  } finally {
    signal.removeEventListener("abort", onAbort);

    // Best effort on every path, including the abandoned ones: a stream that is
    // cancelled or errored simply has nothing left to release.
    try {
      reader.releaseLock();
    } catch {
      // The stream is already cancelled, errored, or still mid-read.
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function parseJson(
  text: string,
  status: number,
  operation: SdkOperation,
  errors: ErrorSink,
): unknown {
  if (text === "") {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.mark(
      new SyndrooResponseError(
        `Syndroo returned HTTP ${status} with a body that is not JSON.`,
        {
          status,
          operation,
          requestMayHaveBeenApplied: mayHaveBeenApplied(
            status,
            isWriteOperation(operation),
          ),
        },
      ),
    );
  }
}

function apiError(
  response: Response,
  text: string,
  operation: SdkOperation,
  errors: ErrorSink,
): SyndrooApiError {
  const isWrite = isWriteOperation(operation);
  const code = publicErrorCode(errorCode(text), response.status);

  return errors.mark(
    new SyndrooApiError(apiMessage(operation, response.status, code, isWrite), {
      code,
      status: response.status,
      operation,
      requestMayHaveBeenApplied: mayHaveBeenApplied(response.status, isWrite),
      retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    }),
  );
}

/**
 * The server's code, read defensively. The envelope message is never read: it
 * is provider or storage text and does not belong in an SDK error.
 */
function errorCode(text: string): string | undefined {
  if (text === "") {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }

  const code = safeProperty(safeProperty(parsed, "error"), "code");

  return typeof code === "string" ? code : undefined;
}

/**
 * `Retry-After` is either a number of seconds or an HTTP date. Both are
 * converted to a bounded delay so a caller can honor backpressure without
 * trusting an attacker-controlled header to park the process for days.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }

  const trimmed = header.trim();
  const seconds = Number(trimmed);

  if (trimmed !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(trimmed);

  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/**
 * A write may have been applied when Syndroo accepted it (2xx) or when the
 * failure happened at or after the server's processing boundary (5xx). A 4xx
 * is a decision, so nothing was applied.
 */
function mayHaveBeenApplied(status: number, isWrite: boolean): boolean {
  if (!isWrite) {
    return false;
  }

  return status >= 500 || (status >= 200 && status < 300);
}

/**
 * Recovery text follows the operation. An uncertain post write may mention the
 * same idempotency key and status reads; an uncertain auth write points at
 * `auth.status`/`auth.operation` and never at a post key or a repeated refresh
 * exchange. Reads cannot have changed anything.
 */
function recoveryAdvice(operation: SdkOperation): string {
  switch (operation) {
    case "posts.create":
      return (
        "Syndroo may still have accepted the post: do not resend it with a new " +
        "Idempotency-Key. Look the post up with posts.get or posts.list, or retry " +
        "the identical request with the same key."
      );
    case "auth.set":
      return (
        "The credential write may have landed: check auth.status before retrying, " +
        "and submit the revision you observed."
      );
    case "auth.connect":
      return (
        "The connect request may have started an operation: check auth.status and, " +
        "when you have the operation id, auth.operation before connecting again."
      );
    case "auth.complete":
      return (
        "The completion may have been applied: check auth.status and " +
        "auth.operation for the same operation. A completed operation can be " +
        "replayed explicitly, but the SDK never replays it for you."
      );
    case "auth.refresh":
      return (
        "The refresh exchange may have rotated the credential: check auth.status " +
        "before another attempt, and never repeat the exchange automatically."
      );
    case "auth.remove":
      return "The removal may have been applied: check auth.status before retrying.";
    default:
      return "This was a read, so nothing was created.";
  }
}

function timeoutMessage(
  operation: SdkOperation,
  isWrite: boolean,
  timeoutMs: number,
): string {
  if (!isWrite) {
    return (
      `Request timed out after ${timeoutMs}ms before Syndroo answered. This was ` +
      "a read, so nothing was created; retrying is safe."
    );
  }

  return `Request timed out after ${timeoutMs}ms. ${recoveryAdvice(operation)}`;
}

function abortMessage(operation: SdkOperation, isWrite: boolean): string {
  if (!isWrite) {
    return "The request was aborted after it was sent. This was a read, so nothing was created.";
  }

  return (
    "The request was aborted after it was sent, so the outcome is unknown. " +
    recoveryAdvice(operation)
  );
}

function networkMessage(
  operation: SdkOperation,
  isWrite: boolean,
  networkCode: string | undefined,
): string {
  const suffix = networkCode === undefined ? "" : ` (${networkCode})`;

  if (!isWrite) {
    return (
      `The request failed before a response was received${suffix}. This was a ` +
      "read, so nothing was created."
    );
  }

  return `The request failed before a response was received${suffix}. ${recoveryAdvice(operation)}`;
}

/**
 * The message for a documented failure. The server's own message is never
 * echoed: it may carry provider or storage text.
 */
function apiMessage(
  operation: SdkOperation,
  status: number,
  code: string,
  isWrite: boolean,
): string {
  if (!isWrite) {
    return `Syndroo answered HTTP ${status} ${code}. This was a read, so nothing was created.`;
  }

  if (status === 429) {
    return (
      `Syndroo answered HTTP ${status} ${code} and asked this client to slow ` +
      "down. Nothing was applied; wait for the Retry-After hint before sending " +
      "the identical request again."
    );
  }

  if (status >= 500) {
    return (
      `Syndroo answered HTTP ${status} ${code} after the request was sent. ` +
      recoveryAdvice(operation)
    );
  }

  return `Syndroo rejected the request with HTTP ${status} ${code}, so nothing was applied.`;
}

function redirectMessage(status: number): string {
  return (
    `Syndroo answered with a redirect (HTTP ${status}). The SDK does not follow ` +
    "redirects because the Authorization header must never be forwarded to " +
    "another location; point baseUrl at the final API origin instead."
  );
}

function networkCodeOf(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth += 1) {
    const code = publicNetworkCode(safeProperty(current, "code"));

    if (code !== undefined) {
      return code;
    }

    current = safeProperty(current, "cause");
  }

  return undefined;
}
