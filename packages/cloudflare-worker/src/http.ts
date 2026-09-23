const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_DEADLINE_MS = 15_000;

const TIMEOUT_MESSAGE = "Request body read timed out";
const ABORTED_MESSAGE = "Request body read was cancelled";
const READ_FAILED_MESSAGE = "Request body could not be read";
const INVALID_JSON_MESSAGE = "Request body contains invalid JSON";
const TOO_LARGE_MESSAGE = "Request body is too large";
const MEDIA_TYPE_MESSAGE = "Content-Type must be application/json";

/**
 * How many stored chunks pass before the loop yields to the task queue.
 *
 * A stream that is always ready would otherwise keep the loop in microtasks,
 * where a timer can never fire. One cheap macrotask hop every this many read
 * iterations lets the deadline timer run, so the deadline is enforced by the
 * runtime and not only by the elapsed-time check. The cadence counts reads, not
 * stored chunks: a stream that stops producing bytes after its first chunk must
 * still yield.
 */
const YIELD_EVERY_CHUNKS = 64;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function requireBearer(
  request: Request,
  expected: string,
): Promise<void> {
  const provided = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];

  if (!provided || !(await verifyToken(provided, expected))) {
    throw new ApiError("Unauthorized", 401, "UNAUTHORIZED");
  }
}

/**
 * Optional bounds for one body read.
 *
 * Both limits are downward-only overrides of the fixed production values, so a
 * test can exercise the deadline and the cap without a slow or huge fixture and
 * no caller can widen the inbound boundary.
 */
export interface BodyReadOptions {
  readonly maxBytes?: number;
  readonly deadlineMs?: number;
}

/**
 * Read one bounded JSON request body.
 *
 * The body is read under a total deadline and the request's own cancellation
 * signal, every chunk is copied before the next await, and the bytes are
 * decoded as strict UTF-8 before parsing. Every failure is a fixed `ApiError`:
 * a media-type mismatch keeps 415, an oversized body keeps 413, and a timeout,
 * cancellation, stream failure or malformed body is a controlled 400. Decoder
 * text, submitted bytes, provider text and raw causes never travel.
 */
export async function readJsonBody(
  request: Request,
  options?: BodyReadOptions,
): Promise<unknown> {
  const bounds = resolveBounds(options);

  if (!isJsonContentType(request.headers.get("content-type"))) {
    cancelBody(request);
    throw new ApiError(MEDIA_TYPE_MESSAGE, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  rejectDeclaredOversize(request, bounds);

  const bytes = await readBodyBytes(request, bounds);

  if (bytes === null) {
    throw new ApiError("Request body is required", 400, "INVALID_JSON");
  }

  return decodeJson(bytes);
}

/**
 * Read one optional JSON request body.
 *
 * Returns `undefined` only when there is no body at all or the body is truly
 * zero bytes, which is the legacy "empty mutation body" shape. A present `null`
 * document parses to `null` and is therefore distinct from `undefined`, and a
 * malformed nonempty body is still a controlled 400. A zero-byte body needs no
 * media type because there is nothing to decode; any nonempty body must carry
 * exactly `application/json` (case-insensitive, parameters allowed).
 */
export async function readOptionalJsonBody(
  request: Request,
  options?: BodyReadOptions,
): Promise<unknown | undefined> {
  const bounds = resolveBounds(options);

  rejectDeclaredOversize(request, bounds);

  const bytes = await readBodyBytes(request, bounds);

  if (bytes === null || bytes.byteLength === 0) {
    return undefined;
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    cancelBody(request);
    throw new ApiError(MEDIA_TYPE_MESSAGE, 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  return decodeJson(bytes);
}

interface BodyBounds {
  readonly maxBytes: number;
  readonly deadlineMs: number;
}

function resolveBounds(options: BodyReadOptions | undefined): BodyBounds {
  const maxBytes = options?.maxBytes ?? MAX_REQUEST_BYTES;
  const deadlineMs = options?.deadlineMs ?? REQUEST_DEADLINE_MS;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REQUEST_BYTES) {
    throw new RangeError("body read maxBytes must be a positive integer up to 65536");
  }

  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > REQUEST_DEADLINE_MS) {
    throw new RangeError("body read deadlineMs must be a positive integer up to 15000");
  }

  return { maxBytes, deadlineMs };
}

/**
 * Exact media-type check.
 *
 * The type must be `application/json` (case-insensitive) with only optional
 * parameters after it, so `application/jsonp`, `application/json-seq` and
 * `application/json-patch+json` are rejected instead of being accepted by a
 * prefix comparison.
 */
function isJsonContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const separator = value.indexOf(";");
  const mime = (separator === -1 ? value : value.slice(0, separator)).trim().toLowerCase();

  return mime === "application/json";
}

/** Reject an advertised length before reading a single byte. */
function rejectDeclaredOversize(request: Request, bounds: BodyBounds): void {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);

  if (declaredLength > bounds.maxBytes) {
    cancelBody(request);
    throw new ApiError(TOO_LARGE_MESSAGE, 413, "BODY_TOO_LARGE");
  }
}

/**
 * Best-effort, non-blocking disposal of a body this helper refuses to read.
 *
 * The cancellation is never awaited and both settlement paths are observed, so
 * an early 413/415 can neither hang on a slow cancellation nor leave an
 * unhandled rejection behind.
 */
function cancelBody(request: Request): void {
  let body: ReadableStream<Uint8Array> | null;

  try {
    body = request.body;
  } catch {
    return;
  }

  if (body === null) {
    return;
  }

  try {
    void Promise.resolve(body.cancel()).then(noop, noop);
  } catch {
    // A locked or disturbed body cannot be cancelled; nothing else to do.
  }
}

function noop(): void {
  // Intentionally empty: used only to observe a settlement.
}

/** One macrotask hop, so a pending timer can run. */
function yieldToTimers(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Read the whole body, or `null` when the request has no body stream at all.
 *
 * The returned bytes are copied, so the caller never observes a buffer the
 * runtime may reuse for a later chunk.
 */
async function readBodyBytes(
  request: Request,
  bounds: BodyBounds,
): Promise<Uint8Array | null> {
  // Cancellation is checked explicitly before any body handling: an aborted
  // request must never return a parsed body, not even when its stream is
  // already holding ready bytes that would win a race against the timer.
  if (request.signal.aborted) {
    cancelBody(request);
    throw new ApiError(ABORTED_MESSAGE, 400, "INVALID_REQUEST");
  }

  // A body the caller already consumed is not an empty body: the request's
  // stream is disturbed, so reading it here would report a legacy "absent
  // payload" for data that was really submitted. Nothing is cancelled or
  // released here, because the caller owns that stream.
  if (request.bodyUsed) {
    throw new ApiError(READ_FAILED_MESSAGE, 400, "INVALID_REQUEST");
  }

  const stream = request.body;

  if (stream === null) {
    return null;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;

  try {
    reader = stream.getReader();
  } catch {
    // A locked or disturbed body is a controlled read failure, never a raw
    // TypeError from the streams implementation.
    throw new ApiError(READ_FAILED_MESSAGE, 400, "INVALID_REQUEST");
  }

  const stop = createStopSignal(request.signal, bounds.deadlineMs);
  const startedAt = Date.now();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let iterations = 0;

  try {
    while (true) {
      // The stop state is read directly, so a race the timer loses to an
      // already-ready read can never turn a cancelled or expired read into a
      // success. The elapsed check keeps the deadline finite for a stream that
      // always has bytes queued and would otherwise starve the timer.
      const stopped = stopState(stop, request.signal, startedAt, bounds.deadlineMs);

      if (stopped !== null) {
        disposeReader(reader);
        throw stoppedError(stopped);
      }

      let outcome: ReadableStreamReadResult<Uint8Array> | "timeout" | "aborted";

      try {
        outcome = await Promise.race([reader.read(), stop.promise]);
      } catch {
        // Only the awaited read can reject here. The rejection object is never
        // inspected or rethrown: a stream failure cannot hand this boundary its
        // own error text, not even a forged `ApiError`.
        disposeReader(reader);
        throw new ApiError(READ_FAILED_MESSAGE, 400, "INVALID_REQUEST");
      }

      if (typeof outcome === "string") {
        // The pending read is abandoned without being awaited: a hanging
        // cancellation must not delay the response.
        disposeReader(reader);
        throw stoppedError(outcome);
      }

      iterations += 1;

      // The stop state is checked again after the awaited read: a cancellation
      // or deadline that landed inside that read must win even when the read
      // itself resolved first, so a final chunk or a final `done` can never turn
      // a cancelled read into a success.
      const stoppedAfterRead = stopState(stop, request.signal, startedAt, bounds.deadlineMs);

      if (stoppedAfterRead !== null) {
        disposeReader(reader);
        throw stoppedError(stoppedAfterRead);
      }

      if (outcome.done) {
        break;
      }

      const value = outcome.value;
      const remaining = bounds.maxBytes - length;

      // Size is proven from the received chunk before it is copied, so an
      // oversized chunk never causes an extra unbounded allocation.
      if (value.byteLength > remaining) {
        disposeReader(reader);
        throw new ApiError(TOO_LARGE_MESSAGE, 413, "BODY_TOO_LARGE");
      }

      length += value.byteLength;

      if (value.byteLength > 0) {
        // Copy before the next await: the runtime may reuse the chunk buffer.
        chunks.push(Uint8Array.from(value));
      }

      if (iterations % YIELD_EVERY_CHUNKS === 0) {
        // Periodic macrotask hop: a hot microtask loop must never starve the
        // deadline timer that bounds this read.
        await yieldToTimers();
      }
    }
  } finally {
    stop.dispose();
    releaseReader(reader);
  }

  return joinChunks(chunks, length);
}

/** One fixed failure for a timed-out or cancelled read. */
function stoppedError(reason: "timeout" | "aborted"): ApiError {
  return new ApiError(
    reason === "timeout" ? TIMEOUT_MESSAGE : ABORTED_MESSAGE,
    400,
    "INVALID_REQUEST",
  );
}

/**
 * Current stop state, independent of which promise won a race.
 *
 * The request signal is checked first so cancellation always wins over an
 * already-ready read; the elapsed check makes the deadline finite even for a
 * stream that keeps the loop in microtasks and starves the timer.
 */
function stopState(
  stop: StopSignal,
  signal: AbortSignal,
  startedAt: number,
  deadlineMs: number,
): "timeout" | "aborted" | null {
  if (signal.aborted) {
    return "aborted";
  }

  const settled = stop.reason();

  if (settled !== null) {
    return settled;
  }

  return Date.now() - startedAt >= deadlineMs ? "timeout" : null;
}

/**
 * One shared deadline and cancellation signal for the whole read.
 *
 * The promise resolves (never rejects), so a lost race cannot produce an
 * unhandled rejection; the settled reason stays readable through `reason()`,
 * so the caller never depends on winning a race; `dispose` always releases the
 * timer and the listener.
 */
interface StopSignal {
  readonly promise: Promise<"timeout" | "aborted">;
  readonly reason: () => "timeout" | "aborted" | null;
  readonly dispose: () => void;
}

function createStopSignal(signal: AbortSignal, deadlineMs: number): StopSignal {
  let settled: "timeout" | "aborted" | null = null;
  let resolveStop: (reason: "timeout" | "aborted") => void = noop;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const promise = new Promise<"timeout" | "aborted">((resolve) => {
    resolveStop = resolve;
  });

  const settle = (reason: "timeout" | "aborted"): void => {
    if (settled === null) {
      settled = reason;
      resolveStop(reason);
    }
  };

  timer = setTimeout(() => settle("timeout"), deadlineMs);

  if (signal.aborted) {
    settle("aborted");
  } else {
    onAbort = () => settle("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    promise,
    reason: () => settled,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Dispose a reader that may still have a pending read.
 *
 * `cancel()` is deliberately never awaited: a hung cancellation promise must
 * not delay the response. The lock is released as soon as the runtime settles,
 * and both settlement paths are observed so a late rejection can never become
 * an unhandled rejection.
 */
function disposeReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  let cancelled: Promise<void>;

  try {
    cancelled = reader.cancel();
  } catch {
    releaseReader(reader);
    return;
  }

  void cancelled.then(
    () => releaseReader(reader),
    () => releaseReader(reader),
  );
}

/** Release the lock when the reader is quiescent; never surface a refusal. */
function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A reader with a pending read refuses the release; the deferred release in
    // `disposeReader` retries it once the runtime settles the read.
  }
}

function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/** Strict UTF-8, then JSON. Both failures share one fixed message. */
function decodeJson(bytes: Uint8Array): unknown {
  let text: string;

  try {
    // `ignoreBOM: false` keeps the previous behaviour of stripping a leading
    // BOM; `fatal: true` rejects malformed UTF-8 instead of substituting.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(INVALID_JSON_MESSAGE, 400, "INVALID_JSON");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(INVALID_JSON_MESSAGE, 400, "INVALID_JSON");
  }
}

async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}
