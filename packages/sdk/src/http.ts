/**
 * HTTP transport for `@syndroo/sdk`.
 *
 * Scope, deliberately narrow:
 *
 * - `POST /v1/connect`, `POST /v1/publish`, `POST /v1/status` only. There is no
 *   GET business route, no health probe and no CRUD family.
 * - The bearer secret is required and travels only in the `Authorization`
 *   header. It is never placed in a URL, a query string or an error.
 * - The base URL is checked before any socket is opened. Credentials/userinfo,
 *   a query and a fragment are rejected, and plain HTTP is accepted only for a
 *   loopback host, because a remote cleartext endpoint would expose the bearer
 *   secret to the network.
 * - Redirects are never followed (`redirect: "manual"`). Following one would
 *   forward the `Authorization` header to an origin the caller never chose.
 * - A request body is bounded and validated by the generated validator (64 KiB);
 *   a response is read with a hard 1 MiB cap while streaming, decoded as strict
 *   UTF-8 and parsed by the generated bounded parser, then validated as an
 *   envelope whose `operation` must match the call.
 * - Transport retries reuse one idempotency key. A valid envelope is never
 *   retried, whatever its business result says: `failed`, `partial` and
 *   `unknown` are protocol successes, not transport errors.
 */

import { SyndrooError } from "./errors.js";
import { parseStrictResponseJson } from "./generated/validation.js";
import { validateWire, type WireName } from "./generated/validators.js";
import type { Envelope, FetchLike, SafeError, WireOperation } from "./types.js";

/** Protocol and transport bounds. Changing one is an API decision. */
export const LIMITS = Object.freeze({
  /** Largest request body the wire protocol accepts. */
  maxRequestBytes: 65536,
  /** Largest response body the SDK will buffer. */
  maxResponseBytes: 1048576,
  /** Default per-request deadline. */
  defaultTimeoutMs: 30000,
  /** Smallest accepted per-request deadline. */
  minTimeoutMs: 1,
  /** Largest per-request deadline the protocol allows. */
  maxTimeoutMs: 120000,
  /** Largest number of transport retries the protocol allows. */
  maxTransportRetries: 2,
  /** Longest accepted caller-supplied idempotency key. */
  maxIdempotencyKeyLength: 128,
});

/**
 * Statuses retried at the transport layer only when no valid envelope came back.
 *
 * These are the classic "something between the client and the application
 * failed" statuses: a gateway or a crashed worker answered while the Syndroo
 * server never produced a protocol response. Retrying is safe because the
 * request identity is reused, so an already-admitted operation is looked up
 * instead of repeated. `429` is deliberately absent: rate limiting is an
 * admission answer, not a transport failure.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set<number>([408, 500, 502, 503, 504]);

/** Statuses that may carry an `ok: true` protocol envelope. */
const ACCEPTED_STATUS: ReadonlySet<number> = new Set<number>([200, 202]);

/**
 * The blueprint's idempotency-key grammar: one to 128 characters from
 * `[A-Za-z0-9._:-]`. Anything else (whitespace, punctuation, an over-long key)
 * is rejected before a request is built.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type TransportConfig = {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
};

/** One prepared transport call. */
export type TransportRequest = {
  operation: WireOperation;
  /** Generated wire name of the request body, used for validation. */
  wireName: WireName;
  body: unknown;
  idempotencyKey?: string;
  timeoutMs: number;
  transportRetries: number;
  signal?: AbortSignal;
};

/** The loopback hosts that may be reached over plain HTTP. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host === "::1") {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) {
    return false;
  }
  const octets = ipv4.slice(1, 5).map((part) => Number.parseInt(part ?? "", 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return false;
  }
  return octets[0] === 127;
}

/**
 * Validate a base URL, or throw a static `INSECURE_BASE_URL` error.
 *
 * Rejected: a non-absolute URL, a scheme other than HTTP or HTTPS, embedded
 * credentials, a query, a fragment, and plain HTTP to anything that is not
 * loopback.
 */
export function assertUsableBaseUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SyndrooError("INSECURE_BASE_URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyndrooError("INSECURE_BASE_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SyndrooError("INSECURE_BASE_URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SyndrooError("INSECURE_BASE_URL");
  }
  if (url.hash !== "" || url.search !== "") {
    throw new SyndrooError("INSECURE_BASE_URL");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new SyndrooError("INSECURE_BASE_URL");
  }
  return url;
}

/** Validate the API key before any request is built. */
export function assertApiKey(apiKey: string): string {
  if (typeof apiKey !== "string" || apiKey.length === 0 || /[\r\n\u0000]/.test(apiKey)) {
    throw new SyndrooError("INVALID_ARGUMENT");
  }
  return apiKey;
}

/** Validate a caller- or SDK-generated idempotency key. */
export function assertIdempotencyKey(key: string): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new SyndrooError("INVALID_ARGUMENT");
  }
  return key;
}

function assertIntegerInRange(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SyndrooError("INVALID_ARGUMENT");
  }
  return value;
}

/** Resolve and bound the per-call transport options. */
export function resolveTransportOptions(options: {
  timeoutMs?: number;
  transportRetries?: number;
}): { timeoutMs: number; transportRetries: number } {
  const timeoutMs =
    options.timeoutMs === undefined
      ? LIMITS.defaultTimeoutMs
      : assertIntegerInRange(options.timeoutMs, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs);
  const transportRetries =
    options.transportRetries === undefined
      ? 0
      : assertIntegerInRange(options.transportRetries, 0, LIMITS.maxTransportRetries);
  return { timeoutMs, transportRetries };
}

/** Keep a pending timer from holding the process open, when the runtime allows it. */
export function unrefTimer(timer: unknown): void {
  if (timer !== null && typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Read a response body with a hard byte cap instead of buffering blindly.
 *
 * A rejection path calls `onReject` after releasing the body, so the caller can
 * abort the request too: leaving a rejected response's body unread keeps the
 * socket alive and can hold the process open.
 */
async function readBoundedBody(
  response: Response,
  limit: number,
  onReject: () => void,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number.parseInt(declared, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      await cancelBody(response);
      onReject();
      throw new SyndrooError("RESPONSE_TOO_LARGE", { status: response.status });
    }
  }
  const stream = response.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      onReject();
      throw new SyndrooError("RESPONSE_TOO_LARGE", { status: response.status });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Release a response body the SDK is not going to read. */
async function cancelBody(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // A body that is already errored or locked cannot be cancelled; the request
    // abort that follows still releases the socket.
  }
}

type EnvelopeOutcome =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "rejected"; readonly error: SafeError }
  | { readonly kind: "malformed" };

/**
 * Parse and validate one response envelope.
 *
 * Extra fields are tolerated (the generated response validator ignores them);
 * an unknown enum value, a missing required field, invalid UTF-8, invalid JSON
 * or a mismatched `operation` are all `malformed`.
 */
function readEnvelope(bytes: Uint8Array, operation: WireOperation): EnvelopeOutcome {
  if (bytes.byteLength === 0) {
    return { kind: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = parseStrictResponseJson(bytes);
  } catch {
    return { kind: "malformed" };
  }
  try {
    validateWire("Envelope", parsed, true);
  } catch {
    return { kind: "malformed" };
  }
  const envelope = parsed as Envelope;
  if (envelope.operation !== operation) {
    return { kind: "malformed" };
  }
  if (envelope.ok) {
    return { kind: "result", result: envelope.result };
  }
  return { kind: "rejected", error: envelope.error };
}

/**
 * A transport bound to one base URL and one bearer secret.
 *
 * The class owns the retry loop, so a retry always reuses the same idempotency
 * key: the key is part of `TransportRequest` and is never regenerated.
 */
export class HttpTransport {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: TransportConfig) {
    this.baseUrl = assertUsableBaseUrl(config.baseUrl);
    this.apiKey = assertApiKey(config.apiKey);
    this.fetchImpl = config.fetch;
  }

  /** The origin the transport will talk to; safe for tests and diagnostics. */
  get endpointOrigin(): string {
    return this.baseUrl.origin;
  }

  /** Validate the body, then send it, retrying only transport-level failures. */
  async send(request: TransportRequest): Promise<unknown> {
    if (request.idempotencyKey !== undefined) {
      assertIdempotencyKey(request.idempotencyKey);
    }
    try {
      validateWire(request.wireName, request.body, false);
    } catch {
      throw new SyndrooError("INVALID_REQUEST");
    }

    const url = this.buildUrl(request.operation);
    const payload = JSON.stringify(request.body);
    const attempts = request.transportRetries + 1;
    let lastError: SyndrooError | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.attempt(url, payload, request);
      } catch (error) {
        const failure = error instanceof SyndrooError ? error : new SyndrooError("TRANSPORT");
        if (!failure.retryable || attempt + 1 >= attempts) {
          throw failure;
        }
        lastError = failure;
      }
    }

    throw lastError ?? new SyndrooError("TRANSPORT");
  }

  private buildUrl(operation: WireOperation): string {
    const base = this.baseUrl.origin + this.baseUrl.pathname.replace(/\/+$/, "");
    return `${base}/v1/${operation}`;
  }

  private async attempt(url: string, payload: string, request: TransportRequest): Promise<unknown> {
    const controller = new AbortController();
    const external = request.signal;
    if (external !== undefined && external.aborted) {
      throw new SyndrooError("ABORTED");
    }
    const onExternalAbort = (): void => controller.abort();
    external?.addEventListener("abort", onExternalAbort, { once: true });

    let deadlineElapsed = false;
    const timer = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort();
    }, request.timeoutMs);
    unrefTimer(timer);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: buildHeaders(this.apiKey, request.idempotencyKey),
        body: payload,
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        controller.abort();
        throw new SyndrooError("REDIRECT_NOT_ALLOWED", { status: response.status });
      }

      const bytes = await readBoundedBody(response, LIMITS.maxResponseBytes, () =>
        controller.abort(),
      );
      return unwrapEnvelope(readEnvelope(bytes, request.operation), response.status, request.operation);
    } catch (error) {
      if (error instanceof SyndrooError) {
        throw error;
      }
      throw classifyThrown(external, deadlineElapsed);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function buildHeaders(apiKey: string, idempotencyKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (idempotencyKey !== undefined) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return headers;
}

/**
 * Turn a validated envelope into a value or a static error.
 *
 * `ok: false` is an authoritative protocol answer, so it is never retried: the
 * server already did whatever it is going to do. A non-envelope 2xx is a
 * protocol violation; a non-envelope error status is an HTTP failure, retryable
 * only for the statuses that mean "the application never answered".
 *
 * `202` is reserved by the protocol for an already durably admitted execution
 * that has not reached a terminal status. It is a correlation, not a generic
 * "accepted": a status query, a connect step, a prepared result or a terminal
 * execution answered with `202` is a protocol violation.
 */
function unwrapEnvelope(outcome: EnvelopeOutcome, status: number, operation: WireOperation): unknown {
  if (outcome.kind === "result") {
    if (!ACCEPTED_STATUS.has(status)) {
      throw new SyndrooError("INVALID_RESPONSE", { status });
    }
    if (status === 202 && !isAdmittedNonterminalExecution(operation, outcome.result)) {
      throw new SyndrooError("INVALID_RESPONSE", { status });
    }
    return outcome.result;
  }
  if (outcome.kind === "rejected") {
    throw new SyndrooError("PROTOCOL", { status, serverError: outcome.error });
  }
  if (ACCEPTED_STATUS.has(status)) {
    throw new SyndrooError("INVALID_RESPONSE", { status });
  }
  throw new SyndrooError("HTTP_ERROR", { status, retryable: RETRYABLE_STATUS.has(status) });
}

/** True for the only result a `202` may carry: admitted, non-terminal execution. */
function isAdmittedNonterminalExecution(operation: WireOperation, result: unknown): boolean {
  if (operation !== "publish" || result === null || typeof result !== "object") {
    return false;
  }
  const candidate = result as { phase?: unknown; status?: unknown };
  return (
    candidate.phase === "execution" &&
    (candidate.status === "pending" || candidate.status === "running")
  );
}

/** Classify a thrown fetch or stream error without echoing it. */
function classifyThrown(external: AbortSignal | undefined, deadlineElapsed: boolean): SyndrooError {
  if (external?.aborted === true) {
    return new SyndrooError("ABORTED");
  }
  if (deadlineElapsed) {
    return new SyndrooError("TIMEOUT", { retryable: true });
  }
  return new SyndrooError("TRANSPORT", { retryable: true });
}
