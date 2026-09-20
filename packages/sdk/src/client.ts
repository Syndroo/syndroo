/**
 * `SyndrooClient` — a thin, dependency-free client for the Syndroo HTTP API.
 *
 * The client wraps the documented `/v1` contract. It deliberately does not add
 * server features: it creates, reads, lists, and waits, and it never invents a
 * delivery result that the server did not report.
 */

import {
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooConfigError,
  SyndrooError,
  SyndrooValidationError,
  SyndrooWaitTimeoutError,
} from "./errors.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MIN_MAX_RESPONSE_BYTES,
  sendRequest,
  unrefTimer,
  type TransportConfig,
} from "./http.js";
import {
  isPostTerminal,
  parseHealth,
  parsePostDetail,
  parsePostList,
  parsePostReceipt,
  type CreatePostInput,
  type HealthStatus,
  type PostDetail,
  type PostOverride,
  type PostReceipt,
  type PostSummary,
} from "./types.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;
export const DEFAULT_MAX_POLL_INTERVAL_MS = 2_000;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SyndrooClientOptions {
  /** Origin of a deployed Syndroo instance, for example `https://syndroo.example.com`. */
  baseUrl: string;
  /**
   * The instance API key. Keep it in a server, CLI, or CI credential store;
   * never in a static page or a `NEXT_PUBLIC_*` variable.
   */
  apiKey: string;
  /** Per-request deadline. Defaults to 30000ms. */
  timeoutMs?: number | undefined;
  /** Total deadline for `posts.wait`. Defaults to 60000ms. */
  waitTimeoutMs?: number | undefined;
  /** Maximum accepted response size in bytes. Defaults to 8 MiB. */
  maxResponseBytes?: number | undefined;
  /** Allow plaintext `http://` for a non-loopback host. Off by default. */
  allowInsecureHttp?: boolean | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number | undefined;
}

export interface CreatePostOptions extends RequestOptions {
  /**
   * Stable key for one logical post. Reuse the same key when retrying the same
   * request; Syndroo replays the original result, and different content under
   * the same key is rejected with HTTP 409.
   */
  idempotencyKey?: string | undefined;
}

export interface ListPostsOptions extends RequestOptions {
  /** 1-100, defaults to the server default. */
  limit?: number | undefined;
}

export interface WaitOptions extends RequestOptions {
  /** Total wait budget in milliseconds, not a per-request timeout. */
  timeoutMs?: number | undefined;
  /** First interval between status reads. Defaults to 250ms. */
  pollIntervalMs?: number | undefined;
  /** Upper bound for the backoff. Defaults to 2000ms. */
  maxPollIntervalMs?: number | undefined;
}

/**
 * Client for one Syndroo instance.
 *
 * ```ts
 * const syndroo = new SyndrooClient({
 *   baseUrl: process.env.SYNDROO_BASE_URL!,
 *   apiKey: process.env.SYNDROO_API_KEY!,
 * });
 *
 * const receipt = await syndroo.posts.create(
 *   { content: "We just shipped a new release.", platforms: ["bluesky"] },
 *   { idempotencyKey: "release-announcement-001" },
 * );
 *
 * const post = await syndroo.posts.get(receipt.id);
 * ```
 */
export class SyndrooClient {
  readonly posts: PostsResource;
  readonly #config: TransportConfig;
  readonly #waitTimeoutMs: number;

  constructor(options: SyndrooClientOptions) {
    this.#config = resolveConfig(options);
    this.#waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    validatePositiveDuration(this.#waitTimeoutMs, "waitTimeoutMs");

    if (typeof globalThis.fetch !== "function") {
      throw new SyndrooConfigError(
        "This runtime has no global fetch(). The SDK requires Node.js 22 or newer.",
      );
    }

    this.posts = new PostsResource(this.#config, this.#waitTimeoutMs);
  }

  /**
   * `GET /health`. Syndroo's health endpoint is unauthenticated, so the client
   * sends no Authorization header here. It proves reachability, not that the
   * API key is correct or that the deployment can publish.
   */
  async health(options: RequestOptions = {}): Promise<HealthStatus> {
    const response = await sendRequest(this.#config, {
      method: "GET",
      path: "/health",
      authenticated: false,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    return parseHealth(response.body, { status: response.status });
  }
}

/** The posts resource: create, read, list, and bounded status wait. */
export class PostsResource {
  readonly #config: TransportConfig;
  readonly #defaultWaitTimeoutMs: number;

  constructor(config: TransportConfig, defaultWaitTimeoutMs: number) {
    this.#config = config;
    this.#defaultWaitTimeoutMs = defaultWaitTimeoutMs;
  }

  /**
   * `POST /v1/posts`. The returned receipt is an acceptance result: HTTP 202
   * means the request is queued for processing, not that any platform
   * published it. The SDK performs exactly one request and never retries it.
   */
  async create(
    input: CreatePostInput,
    options: CreatePostOptions = {},
  ): Promise<PostReceipt> {
    validateCreateInput(input);
    const idempotencyKey =
      options.idempotencyKey === undefined
        ? undefined
        : validateIdempotencyKey(options.idempotencyKey);
    const response = await sendRequest(this.#config, {
      method: "POST",
      path: "/v1/posts",
      json: input,
      idempotencyKey,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    return parsePostReceipt(response.body, {
      status: response.status,
      requestMayHaveBeenApplied: true,
    });
  }

  /** `GET /v1/posts/<id>`. Read-only, so repeating it is safe. */
  async get(id: string, options: RequestOptions = {}): Promise<PostDetail> {
    const postId = validatePostId(id);
    const response = await sendRequest(this.#config, {
      method: "GET",
      path: `/v1/posts/${encodeURIComponent(postId)}`,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    return parsePostDetail(response.body, { status: response.status });
  }

  /** `GET /v1/posts`, newest first. */
  async list(options: ListPostsOptions = {}): Promise<PostSummary[]> {
    const limit =
      options.limit === undefined ? undefined : validateLimit(options.limit);
    const response = await sendRequest(this.#config, {
      method: "GET",
      path: "/v1/posts",
      query: limit === undefined ? undefined : { limit: String(limit) },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    return parsePostList(response.body, { status: response.status });
  }

  /**
   * Reads the post until it reaches a terminal status (`published`, `partial`,
   * or `failed`) or the wait budget runs out.
   *
   * Waiting is read-only: it never creates, cancels, or resends a post, so a
   * timeout leaves the server-side work running and only stops this client from
   * waiting. On timeout it throws `SyndrooWaitTimeoutError`, which keeps the
   * post id, the last status, and the last transient error so a caller can
   * resume instead of starting over.
   */
  async wait(id: string, options: WaitOptions = {}): Promise<PostDetail> {
    const postId = validatePostId(id);
    const timeoutMs = options.timeoutMs ?? this.#defaultWaitTimeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPollIntervalMs =
      options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;

    validatePositiveDuration(timeoutMs, "timeoutMs");
    validatePositiveDuration(pollIntervalMs, "pollIntervalMs");
    validatePositiveDuration(maxPollIntervalMs, "maxPollIntervalMs");

    const deadline = Date.now() + timeoutMs;
    let interval = Math.min(pollIntervalMs, maxPollIntervalMs);
    let lastPost: PostDetail | undefined;
    let lastError: SyndrooError | undefined;

    for (;;) {
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        break;
      }

      try {
        const post = await this.get(postId, {
          signal: options.signal,
          timeoutMs: Math.max(1, Math.min(remaining, this.#config.timeoutMs)),
        });
        lastPost = post;
        lastError = undefined;

        if (isPostTerminal(post.status)) {
          return post;
        }
      } catch (error) {
        const failure = toSyndrooError(error);

        if (isFatalWaitFailure(failure)) {
          throw failure;
        }

        lastError = failure;

        if (failure instanceof SyndrooApiError && failure.retryAfterMs !== undefined) {
          interval = Math.max(interval, failure.retryAfterMs);
        }
      }

      const pause = Math.min(interval, Math.max(0, deadline - Date.now()));

      if (pause > 0) {
        await sleep(pause, options.signal);
      }

      interval = Math.min(interval * 2, maxPollIntervalMs);
    }

    throw new SyndrooWaitTimeoutError(waitTimeoutMessage(postId, timeoutMs, lastPost, lastError), {
      postId,
      timeoutMs,
      lastStatus: lastPost?.status,
      lastPost,
      lastError,
    });
  }
}

function waitTimeoutMessage(
  postId: string,
  timeoutMs: number,
  lastPost: PostDetail | undefined,
  lastError: SyndrooError | undefined,
): string {
  const observed =
    lastPost === undefined
      ? "no status was observed"
      : `the last observed status was "${lastPost.status}"`;
  const failure =
    lastError === undefined ? "" : ` The last status read failed with: ${lastError.message}`;

  return (
    `Stopped waiting for post ${postId} after ${timeoutMs}ms: ${observed}. ` +
    "Waiting only reads, so no post was created or cancelled and the server-side " +
    "work continues; resume with posts.get or a longer posts.wait." +
    failure
  );
}

/**
 * Only transient conditions keep a wait going. Authentication, validation, and
 * "not found" are configuration or state problems that will not fix themselves
 * by polling, so they surface immediately.
 */
function isFatalWaitFailure(error: SyndrooError): boolean {
  if (
    error instanceof SyndrooAbortError ||
    error instanceof SyndrooConfigError ||
    error instanceof SyndrooValidationError
  ) {
    return true;
  }

  if (error instanceof SyndrooApiError) {
    return error.status < 500 && error.status !== 429;
  }

  return false;
}

function toSyndrooError(error: unknown): SyndrooError {
  if (error instanceof SyndrooError) {
    return error;
  }

  return new SyndrooError(
    error instanceof Error ? error.message : "Unknown failure",
    { code: "UNKNOWN", cause: error },
  );
}

function resolveConfig(options: SyndrooClientOptions): TransportConfig {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl,
    options.allowInsecureHttp === true,
  );
  const apiKey = validateApiKey(options.apiKey);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  validatePositiveDuration(timeoutMs, "timeoutMs");

  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < MIN_MAX_RESPONSE_BYTES
  ) {
    throw new SyndrooConfigError(
      `maxResponseBytes must be an integer of at least ${MIN_MAX_RESPONSE_BYTES} bytes.`,
    );
  }

  return { baseUrl, apiKey, timeoutMs, maxResponseBytes };
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyndrooConfigError(
      "baseUrl is required, for example https://syndroo.example.com.",
    );
  }

  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new SyndrooConfigError(
      `baseUrl must be an absolute URL, received "${value.trim()}".`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SyndrooConfigError(
      `baseUrl must use http or https, received "${url.protocol}".`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new SyndrooConfigError(
      "baseUrl must not embed credentials; pass the API key as apiKey so it is sent only as a Bearer header.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new SyndrooConfigError(
      "baseUrl must not include a query string or fragment.",
    );
  }

  if (
    url.protocol === "http:" &&
    !allowInsecureHttp &&
    !isLoopbackHost(url.hostname)
  ) {
    throw new SyndrooConfigError(
      "baseUrl must use https outside loopback: a bearer token sent over plaintext " +
        "is readable on the path. Pass allowInsecureHttp: true only for a " +
        "deliberate plaintext deployment.",
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("127.")
  );
}

function validateApiKey(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyndrooConfigError(
      "apiKey is required. Keep it in a server, CLI, or CI credential store, " +
        "never in client-side code or a NEXT_PUBLIC_* variable.",
    );
  }

  if (/\s/u.test(value)) {
    throw new SyndrooConfigError(
      "apiKey must not contain whitespace or line breaks.",
    );
  }

  return value;
}

function validatePositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SyndrooConfigError(
      `${label} must be a positive, finite number of milliseconds.`,
    );
  }
}

function validateCreateInput(input: CreatePostInput): void {
  if (input === null || typeof input !== "object") {
    throw new SyndrooValidationError(
      "A post requires a content string and a list of platforms.",
    );
  }

  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new SyndrooValidationError("content must be a non-empty string.");
  }

  if (!Array.isArray(input.platforms) || input.platforms.length === 0) {
    throw new SyndrooValidationError(
      "platforms must be a non-empty array of platform names.",
    );
  }

  input.platforms.forEach((platform, index) => {
    if (typeof platform !== "string" || platform.trim().length === 0) {
      throw new SyndrooValidationError(
        `platforms[${index}] must be a non-empty string.`,
      );
    }
  });

  if (input.scheduledAt !== undefined) {
    if (
      typeof input.scheduledAt !== "string" ||
      Number.isNaN(Date.parse(input.scheduledAt))
    ) {
      throw new SyndrooValidationError(
        "scheduledAt must be an ISO 8601 date-time string with an explicit " +
          "offset, for example 2030-01-02T03:04:05.000Z.",
      );
    }
  }

  const overrides: Record<string, PostOverride> | undefined = input.overrides;

  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== "object") {
      throw new SyndrooValidationError(
        "overrides must be an object keyed by platform name.",
      );
    }

    for (const [platform, override] of Object.entries(overrides)) {
      if (override === null || typeof override !== "object") {
        throw new SyndrooValidationError(
          `overrides.${platform} must be an object with an optional content string.`,
        );
      }

      const content: unknown = override.content;

      if (content !== undefined && typeof content !== "string") {
        throw new SyndrooValidationError(
          `overrides.${platform}.content must be a string.`,
        );
      }
    }
  }
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new SyndrooValidationError(
      "idempotencyKey must use 1-128 letters, digits, dots, underscores, colons, " +
        "or hyphens, and must be reused for the same logical post.",
    );
  }

  return value;
}

function validatePostId(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyndrooValidationError("A post id is required.");
  }

  return value;
}

function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new SyndrooValidationError("limit must be an integer between 1 and 100.");
  }

  return value;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        new SyndrooAbortError(
          "Waiting was aborted before the next status read. Nothing was created or cancelled.",
          { cause: signal.reason },
        ),
      );
      return;
    }

    const handle = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    const onAbort = (): void => {
      finish();
      reject(
        new SyndrooAbortError(
          "Waiting was aborted. Nothing was created or cancelled; the post continues on the server.",
          { cause: signal?.reason },
        ),
      );
    };

    function finish(): void {
      clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
    }

    unrefTimer(handle);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
