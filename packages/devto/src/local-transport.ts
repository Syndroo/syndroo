/**
 * Bounded HTTP transport for the local DEV.to provider.
 *
 * Runtime-neutral: no Node imports. Every request goes to the one hardcoded
 * `https://dev.to` origin, refuses redirects, and reads every response body with
 * a hard 1 MiB cap. The deadline races the actual transport call and body read,
 * so an injected transport that ignores the abort signal still cannot outlive
 * the budget.
 */

/** Design §9.1 budget: one response may carry at most 1 MiB. */
export const MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_TIMEOUT_MS = 15_000;

const MAX_RETRY_AFTER_SECONDS = 604_800;
const MAX_RETRY_AFTER_HEADER = 64;
const MAX_ERROR_EVIDENCE = 512;
const MAX_ERROR_ENTRIES = 64;

/** RFC 7231 delta-seconds: decimal digits only. */
const DELTA_SECONDS_PATTERN = /^[0-9]{1,6}$/;

/** RFC 7231 IMF-fixdate, the only date grammar a sender is required to use. */
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12][0-9]|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} (?:[01][0-9]|2[0-3]):[0-5][0-9]:(?:[0-5][0-9]|60) GMT$/;

export type TransportFailure =
  | "RESPONSE_TOO_LARGE"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "ABORTED";

export class LocalTransportError extends Error {
  constructor(readonly reason: TransportFailure) {
    super(reason);
    this.name = "LocalTransportError";
  }
}

export interface Deadline {
  readonly signal: AbortSignal;
  /** True when the local deadline fired rather than the caller's signal. */
  timedOut(): boolean;
  cleanup(): void;
}

/**
 * Links the caller's signal with a local total deadline. Cleanup is explicit so
 * a finished call never leaves a pending timer or listener behind.
 */
export function createDeadline(external: AbortSignal, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    controller.abort();
  };

  if (external.aborted) {
    controller.abort();
  } else {
    external.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external.removeEventListener("abort", onAbort);
    },
  };
}

export interface BoundedResponse {
  readonly status: number;
  readonly body: unknown;
  /** Raw Retry-After header, bounded and unparsed. */
  readonly retryAfter: string | null;
}

export async function requestBounded(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<BoundedResponse> {
  return raceAbort(
    (async () => {
      // DEV.to never follows a redirect: a 3xx must surface as a transport
      // failure, not as a silently different request.
      const response = await transport(url, { ...init, redirect: "error", signal });
      const body = await readBoundedJson(response, signal);

      return {
        status: response.status,
        body,
        retryAfter: rawHeader(response, "retry-after"),
      };
    })(),
    signal,
  );
}

/**
 * Bounds an operation by the signal without trusting the operation to observe
 * it. Handlers are attached before the already-aborted check, so an early
 * rejection can never surface as an unhandled rejection.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", handleAbort);
      action();
    };

    const handleAbort = (): void => {
      finish(() => reject(new LocalTransportError("ABORTED")));
    };

    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * A bounded Forem error envelope: a non-empty `error` string or a non-empty
 * `errors` object/array. The content is never surfaced; it only proves the
 * platform deliberately rejected the request.
 */
export function foremErrorEvidence(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }

  const record = body as Record<string, unknown>;
  const error = record.error;

  if (typeof error === "string" && error.length > 0 && error.length <= MAX_ERROR_EVIDENCE) {
    return true;
  }

  const errors = record.errors;

  if (Array.isArray(errors)) {
    return errors.length > 0 && errors.length <= MAX_ERROR_ENTRIES;
  }

  return (
    typeof errors === "object" &&
    errors !== null &&
    !Array.isArray(errors) &&
    Object.keys(errors).length > 0 &&
    Object.keys(errors).length <= MAX_ERROR_ENTRIES
  );
}

/**
 * How long a rate-limited caller was told to wait.
 *
 * - `none`: no header. The platform still rejected us, so a retry stays allowed
 *   with no scheduled time.
 * - `at`: a representable future instant inside the bound.
 * - `unsafe`: a header was supplied but cannot be represented safely, so the
 *   caller must refuse to schedule an early retry instead of guessing.
 */
export type RetryHint =
  | { readonly kind: "none" }
  | { readonly kind: "at"; readonly retryNotBefore: string }
  | { readonly kind: "unsafe" };

export function readRetryHint(value: string | null, now: number = Date.now()): RetryHint {
  if (value === null) {
    return { kind: "none" };
  }

  if (value.length === 0 || value.length > MAX_RETRY_AFTER_HEADER) {
    return { kind: "unsafe" };
  }

  // `+1`, `0x10`, `1e2`, and `1.5` are not delta-seconds and must not be
  // rescued by a lenient date parser.
  if (DELTA_SECONDS_PATTERN.test(value)) {
    const seconds = Number(value);

    if (seconds > MAX_RETRY_AFTER_SECONDS) {
      return { kind: "unsafe" };
    }

    return { kind: "at", retryNotBefore: new Date(now + seconds * 1_000).toISOString() };
  }

  if (IMF_FIXDATE_PATTERN.test(value)) {
    const at = Date.parse(value);

    if (!Number.isNaN(at) && at >= now && at <= now + MAX_RETRY_AFTER_SECONDS * 1_000) {
      return { kind: "at", retryNotBefore: new Date(at).toISOString() };
    }
  }

  return { kind: "unsafe" };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");

  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    cancelQuietly(response);
    throw new LocalTransportError("RESPONSE_TOO_LARGE");
  }

  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const onAbort = (): void => {
    cancelQuietly(response);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), signal);

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > MAX_RESPONSE_BYTES) {
        cancelQuietly(response);
        throw new LocalTransportError("RESPONSE_TOO_LARGE");
      }

      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Cancel without awaiting: a stream that ignores cancellation must not be
    // able to hold the caller open.
    cancelQuietly(response);

    try {
      reader.releaseLock();
    } catch {
      // A read may still be pending after the abort.
    }
  }

  if (length === 0) {
    return undefined;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalTransportError("INVALID_UTF8");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalTransportError("INVALID_JSON");
  }
}

function rawHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name);

  return value === null ? null : value.trim();
}

function cancelQuietly(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The response is already unusable; there is nothing left to clean up.
  }
}
