import { TransportError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 300_000;
/**
 * The design fixes the provider response cap at 64 KiB. A caller may request a
 * smaller bound for a specific call; nothing may request a larger one.
 */
const MAX_RESPONSE_BYTES_LIMIT = 64 * 1024;

export interface TransportRequest {
  /** Absolute HTTPS URL. Credentials, fragments and non-HTTPS targets are rejected. */
  readonly url: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | URLSearchParams;
  /** Defaults to 15s. Must be an integer in `1..300000`. */
  readonly timeoutMs?: number;
  /** Defaults to 64 KiB. Must be an integer in `1..65536`. */
  readonly maxResponseBytes?: number;
  /**
   * `"read"` (default) buffers a bounded body. `"discard"` releases the body
   * without reading it, for providers whose success contract is status plus
   * headers only; status and headers (including `Retry-After`) stay available
   * so error classification is unchanged.
   */
  readonly bodyPolicy?: "read" | "discard";
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: Uint8Array;
  text(): string;
  toResponse(): Response;
}

/**
 * Performs at most one outbound request and returns a bounded response without
 * interpreting it. HTTP status handling, success signals and ambiguity stay in
 * the platform adapter.
 *
 * Guarantees: HTTPS only; `redirect: "manual"` with every 3xx rejected; the
 * deadline covers the request *and* the whole body read; the body is capped;
 * `reader.cancel()` is never awaited; a failure path tears the connection down
 * with `abort()`; nothing is retried; the timer and both abort listeners are
 * always released.
 */
export async function boundedRequest(
  request: TransportRequest,
): Promise<TransportResponse> {
  const target = validateTarget(request.url);
  const timeoutMs = boundedInteger(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    1,
    MAX_TIMEOUT_MS,
  );
  const maxResponseBytes = boundedInteger(
    request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    1,
    MAX_RESPONSE_BYTES_LIMIT,
  );

  // A caller that aborted before we started never dispatches a request.
  if (request.signal?.aborted === true) {
    throw new TransportError("aborted", false);
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let dispatched = false;
  let rejectOnAbort: (() => void) | undefined;

  const forwardAbort = (): void => {
    callerAborted = true;
    controller.abort();
  };

  request.signal?.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Racing reads against this promise keeps the call bounded even when a custom
  // or mocked stream ignores the abort signal entirely.
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => {
      // `dispatched` is read at abort time, so an abort before `fetch` is never
      // reported as a dispatched request.
      reject(new TransportError(failureCode(timedOut, callerAborted), dispatched));
    };

    if (controller.signal.aborted) {
      rejectOnAbort();
    } else {
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    }
  });
  interrupted.catch(() => undefined);

  try {
    const init: RequestInit = {
      method: request.method,
      redirect: "manual",
      signal: controller.signal,
    };

    if (request.headers !== undefined) {
      init.headers = { ...request.headers };
    }

    if (request.body !== undefined) {
      init.body = asBodyInit(request.body);
    }

    dispatched = true;
    const pending = fetch(target, init);
    // A late rejection after the deadline must not surface as unhandled.
    pending.catch(() => undefined);
    const response = await Promise.race([pending, interrupted]);

    return await readBoundedBody(
      response,
      maxResponseBytes,
      interrupted,
      request.bodyPolicy === "discard",
      controller,
      () => failureCode(timedOut, callerAborted),
    );
  } catch (error) {
    if (error instanceof TransportError) {
      throw error;
    }

    throw new TransportError(failureCode(timedOut, callerAborted), dispatched);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", forwardAbort);

    if (rejectOnAbort !== undefined) {
      controller.signal.removeEventListener("abort", rejectOnAbort);
    }
  }
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  interrupted: Promise<never>,
  discard: boolean,
  controller: AbortController,
  codeFor: () => TransportError["code"],
): Promise<TransportResponse> {
  const reader = response.body === null ? undefined : response.body.getReader();

  try {
    if (response.status >= 300 && response.status < 400) {
      cancelQuietly(reader);
      controller.abort();
      throw new TransportError("redirect", true);
    }

    if (discard) {
      // Status and headers are the whole contract here; the body is released
      // without ever being awaited.
      cancelQuietly(reader);
      controller.abort();
      return buildResponse(response, new Uint8Array(0));
    }

    const declared = declaredLength(response.headers);

    if (declared !== undefined && declared > maxResponseBytes) {
      cancelQuietly(reader);
      controller.abort();
      throw new TransportError("response_too_large", true);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    while (reader !== undefined) {
      const step = await Promise.race([reader.read(), interrupted]);

      if (step.done) {
        break;
      }

      const value = step.value;

      if (value === undefined) {
        continue;
      }

      total += value.byteLength;

      if (total > maxResponseBytes) {
        cancelQuietly(reader);
        controller.abort();
        throw new TransportError("response_too_large", true);
      }

      chunks.push(value);
    }

    return buildResponse(response, concat(chunks, total));
  } catch (error) {
    // Tear the connection down on every failure path; cancellation itself is
    // best-effort and never awaited.
    cancelQuietly(reader);
    controller.abort();

    if (error instanceof TransportError) {
      throw error;
    }

    throw new TransportError(codeFor(), true);
  } finally {
    releaseQuietly(reader);
  }
}

function failureCode(
  timedOut: boolean,
  callerAborted: boolean,
): TransportError["code"] {
  if (timedOut) {
    return "timeout";
  }

  return callerAborted ? "aborted" : "network";
}

function validateTarget(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError("invalid_target", false);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TransportError("invalid_target", false);
  }

  return parsed.toString();
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

function declaredLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");

  if (raw === null) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Cancellation is best-effort and never awaited: a stalled cancel must not block. */
function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void {
  void reader?.cancel().catch(() => undefined);
}

function releaseQuietly(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void {
  try {
    reader?.releaseLock();
  } catch {
    // A read was still pending when the deadline fired; the lock is discarded.
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function buildResponse(response: Response, body: Uint8Array): TransportResponse {
  const headers = new Headers(response.headers);
  const { status } = response;
  const allowsBody = status !== 204 && status !== 205 && status !== 304;

  return {
    status,
    ok: response.ok,
    headers,
    body,
    text: () => new TextDecoder().decode(body),
    toResponse: () =>
      new Response(allowsBody && body.byteLength > 0 ? asBodyInit(body) : null, {
        status,
        headers,
      }),
  };
}

/**
 * `Uint8Array` is a valid `BodyInit` in every supported runtime; the DOM lib's
 * generic `BufferSource` typing only rejects the default buffer type parameter,
 * so the conversion is made explicit here instead of widening the public types.
 */
function asBodyInit(value: Uint8Array | string | URLSearchParams): BodyInit {
  return value as BodyInit;
}
