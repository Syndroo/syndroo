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
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooError,
  SyndrooNetworkError,
  SyndrooResponseError,
  SyndrooTimeoutError,
  truncate,
} from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MIN_MAX_RESPONSE_BYTES = 1024;
const PREVIEW_LIMIT = 200;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface TransportRequest {
  method: "GET" | "POST";
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
): Promise<TransportResponse> {
  const url = buildUrl(config.baseUrl, request.path, request.query);
  const timeoutMs = request.timeoutMs ?? config.timeoutMs;
  const isWrite = request.method !== "GET";
  const userSignal = request.signal;

  if (userSignal?.aborted === true) {
    throw new SyndrooAbortError(
      "The request was aborted before it was sent, so nothing reached Syndroo.",
      { cause: userSignal.reason, requestMayHaveBeenApplied: false },
    );
  }

  // Read through a call so TypeScript's narrowing from the check above does not
  // make the later failure classification unreachable.
  const callerAbort = (): { aborted: boolean; reason: unknown } => ({
    aborted: userSignal?.aborted === true,
    reason: userSignal?.reason,
  });

  const headers = new Headers({ accept: "application/json" });

  if (request.authenticated !== false) {
    headers.set("authorization", `Bearer ${config.apiKey}`);
  }

  if (request.idempotencyKey !== undefined) {
    headers.set("idempotency-key", request.idempotencyKey);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.json !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(request.json);
  }

  const controller = new AbortController();
  let timedOut = false;
  const handle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  unrefTimer(handle);
  init.signal = controller.signal;

  const forwardAbort = (): void => {
    controller.abort();
  };
  userSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await globalThis.fetch(url, init);

    if (isRedirectResponse(response)) {
      throw new SyndrooApiError(
        "Syndroo answered with a redirect. The SDK does not follow redirects " +
          "because the Authorization header must never be forwarded to another " +
          "location; point baseUrl at the final API origin instead.",
        {
          code: "REDIRECT_NOT_FOLLOWED",
          status: response.status,
          requestMayHaveBeenApplied: false,
        },
      );
    }

    const text = await readBody(response, config.maxResponseBytes, isWrite);
    const preview = truncate(text, PREVIEW_LIMIT);

    if (!response.ok) {
      throw apiError(response, text, preview, isWrite);
    }

    return {
      status: response.status,
      body: parseJson(text, response.status, preview, isWrite),
    };
  } catch (error) {
    if (error instanceof SyndrooError) {
      throw error;
    }

    if (timedOut) {
      throw new SyndrooTimeoutError(timeoutMessage(isWrite, timeoutMs), {
        timeoutMs,
        cause: error,
        requestMayHaveBeenApplied: isWrite,
      });
    }

    const caller = callerAbort();

    if (caller.aborted) {
      throw new SyndrooAbortError(abortMessage(isWrite), {
        cause: caller.reason ?? error,
        requestMayHaveBeenApplied: isWrite,
      });
    }

    throw new SyndrooNetworkError(networkMessage(isWrite, error), {
      cause: error,
      networkCode: networkCodeOf(error),
      requestMayHaveBeenApplied: isWrite,
    });
  } finally {
    clearTimeout(handle);
    userSignal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Node keeps the process alive for a pending timer. An SDK call must not pin a
 * CLI process open after its response or its deadline.
 */
export function unrefTimer(handle: unknown): void {
  const candidate = handle as { unref?: unknown };
  const unref = candidate.unref;

  if (typeof unref === "function") {
    (unref as () => void).call(handle);
  }
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

async function readBody(
  response: Response,
  maxBytes: number,
  isWrite: boolean,
): Promise<string> {
  const body = response.body;

  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > maxBytes) {
        await reader.cancel("Response exceeded the SDK response size limit").catch(() => undefined);
        throw new SyndrooResponseError(
          `Syndroo returned a response larger than the configured limit of ${maxBytes} bytes. ` +
            "Raise maxResponseBytes only for a trusted deployment.",
          {
            status: response.status,
            requestMayHaveBeenApplied: mayHaveBeenApplied(response.status, isWrite),
          },
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
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
  preview: string,
  isWrite: boolean,
): unknown {
  if (text === "") {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyndrooResponseError(
      `Syndroo returned HTTP ${status} with a body that is not JSON: ${preview}`,
      {
        status,
        preview,
        requestMayHaveBeenApplied: mayHaveBeenApplied(status, isWrite),
      },
    );
  }
}

function apiError(
  response: Response,
  text: string,
  preview: string,
  isWrite: boolean,
): SyndrooApiError {
  const envelope = errorEnvelope(text);

  return new SyndrooApiError(
    envelope?.message ??
      `Syndroo returned HTTP ${response.status} without a documented error body: ${preview}`,
    {
      code: envelope?.code ?? `HTTP_${response.status}`,
      status: response.status,
      requestMayHaveBeenApplied: mayHaveBeenApplied(response.status, isWrite),
      retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
    },
  );
}

function errorEnvelope(
  text: string,
): { code: string; message: string } | undefined {
  if (text === "") {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const error = (parsed as { error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;

  if (code === undefined || message === undefined) {
    return undefined;
  }

  return { code, message: truncate(message, PREVIEW_LIMIT) };
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

function timeoutMessage(isWrite: boolean, timeoutMs: number): string {
  if (!isWrite) {
    return (
      `Request timed out after ${timeoutMs}ms. This was a read, so nothing was ` +
      "created; retrying is safe."
    );
  }

  return (
    `Request timed out after ${timeoutMs}ms. Syndroo may still have accepted the ` +
    "post: do not resend it with a new Idempotency-Key. Look the post up with " +
    "posts.list, or retry the identical request with the same key."
  );
}

function abortMessage(isWrite: boolean): string {
  if (!isWrite) {
    return "The request was aborted after it was sent. This was a read, so nothing was created.";
  }

  return (
    "The request was aborted after it was sent, so Syndroo may still have " +
    "accepted the post: do not resend it with a new Idempotency-Key. Look the " +
    "post up with posts.list, or retry the identical request with the same key."
  );
}

function networkMessage(isWrite: boolean, error: unknown): string {
  const code = networkCodeOf(error);
  const suffix = code === undefined ? "" : ` (${code})`;

  if (!isWrite) {
    return `The request failed before a response was received${suffix}.`;
  }

  return (
    `The request failed before a response was received${suffix}. Syndroo may ` +
    "still have accepted the post: do not resend it with a new " +
    "Idempotency-Key. Look the post up with posts.list, or retry the identical " +
    "request with the same key."
  );
}

function networkCodeOf(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    const code = (current as { code?: unknown }).code;

    if (typeof code === "string" && code !== "") {
      return truncate(code, 40);
    }

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}
