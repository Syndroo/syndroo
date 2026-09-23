/**
 * `SyndrooClient` — a thin, dependency-free client for the Syndroo HTTP API.
 *
 * The client wraps the documented `/v1` contract. It deliberately does not add
 * server features: it creates, reads, lists, and waits, and it never invents a
 * delivery result that the server did not report.
 */

import {
  createErrorSink,
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooConfigError,
  SyndrooError,
  SyndrooValidationError,
  SyndrooWaitTimeoutError,
  type ErrorSink,
  type SdkOperation,
} from "./errors.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MIN_MAX_RESPONSE_BYTES,
  durationError,
  sendRequest,
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
import { AuthResource } from "./auth.js";
import { parseDiagnostics, type Diagnostics } from "./diagnostics.js";

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
  readonly auth: AuthResource;
  readonly #config: TransportConfig;
  readonly #waitTimeoutMs: number;

  constructor(options: SyndrooClientOptions) {
    this.#config = resolveConfig(options);
    this.#waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    validatePositiveDuration(this.#waitTimeoutMs, "waitTimeoutMs");

    if (typeof globalThis.fetch !== "function") {
      throw configError(
        "This runtime has no global fetch(). The SDK requires Node.js 22 or newer.",
      );
    }

    this.posts = new PostsResource(this.#config, this.#waitTimeoutMs);
    this.auth = new AuthResource(this.#config);
  }

  /**
   * `GET /health`. Syndroo's health endpoint is unauthenticated, so the client
   * sends no Authorization header here. It proves reachability, not that the
   * API key is correct or that the deployment can publish.
   */
  async health(options: RequestOptions = {}): Promise<HealthStatus> {
    const operation: SdkOperation = "health";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "GET",
        operation,
        path: "/health",
        authenticated: false,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );

    return parseHealth(response.body, {
      status: response.status,
      operation,
      errors,
    });
  }

  /**
   * `GET /v1/diagnostics`. Read-only: counts describe current rows, and an
   * unknown storage size or limit is `null` rather than a guess.
   */
  async diagnostics(options: RequestOptions = {}): Promise<Diagnostics> {
    const operation: SdkOperation = "diagnostics";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "GET",
        operation,
        path: "/v1/diagnostics",
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );

    return parseDiagnostics(response.body, {
      status: response.status,
      operation,
      errors,
    });
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
    const operation: SdkOperation = "posts.create";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    validateCreateInput(input, operation, errors);
    const idempotencyKey =
      options.idempotencyKey === undefined
        ? undefined
        : validateIdempotencyKey(options.idempotencyKey, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "POST",
        operation,
        path: "/v1/posts",
        json: input,
        idempotencyKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );

    return parsePostReceipt(response.body, {
      status: response.status,
      requestMayHaveBeenApplied: true,
      operation,
      errors,
    });
  }

  /** `GET /v1/posts/<id>`. Read-only, so repeating it is safe. */
  async get(id: string, options: RequestOptions = {}): Promise<PostDetail> {
    return this.#readPost(id, "posts.get", options, createErrorSink());
  }

  /** `GET /v1/posts`, newest first. */
  async list(options: ListPostsOptions = {}): Promise<PostSummary[]> {
    const operation: SdkOperation = "posts.list";
    const errors = createErrorSink();
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const limit =
      options.limit === undefined
        ? undefined
        : validateLimit(options.limit, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "GET",
        operation,
        path: "/v1/posts",
        query: limit === undefined ? undefined : { limit: String(limit) },
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );

    return parsePostList(response.body, {
      status: response.status,
      operation,
      errors,
    });
  }

  /**
   * One bounded post read, shared by `posts.get` and `posts.wait` so each
   * reports its own operation without duplicating the request.
   */
  async #readPost(
    id: string,
    operation: SdkOperation,
    options: RequestOptions,
    errors: ErrorSink,
  ): Promise<PostDetail> {
    validateRequestDuration(options.timeoutMs, "timeoutMs", operation, errors);
    const postId = validatePostId(id, operation, errors);
    const response = await sendRequest(
      this.#config,
      {
        method: "GET",
        operation,
        path: `/v1/posts/${encodeURIComponent(postId)}`,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
      errors,
    );

    return parsePostDetail(response.body, {
      status: response.status,
      operation,
      errors,
    });
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
    const operation: SdkOperation = "posts.wait";
    const errors = createErrorSink();
    const postId = validatePostId(id, operation, errors);
    const timeoutMs = options.timeoutMs ?? this.#defaultWaitTimeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPollIntervalMs =
      options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;

    validatePositiveDuration(timeoutMs, "timeoutMs", operation, errors);
    validatePositiveDuration(pollIntervalMs, "pollIntervalMs", operation, errors);
    validatePositiveDuration(maxPollIntervalMs, "maxPollIntervalMs", operation, errors);

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
        const post = await this.#readPost(
          postId,
          operation,
          {
            signal: options.signal,
            timeoutMs: Math.max(1, Math.min(remaining, this.#config.timeoutMs)),
          },
          errors,
        );
        lastPost = post;
        lastError = undefined;

        if (isPostTerminal(post.status)) {
          return post;
        }
      } catch (error) {
        const failure = toSyndrooError(error, errors);

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
        await sleep(pause, options.signal, operation, errors);
      }

      interval = Math.min(interval * 2, maxPollIntervalMs);
    }

    throw errors.mark(
      new SyndrooWaitTimeoutError(
        waitTimeoutMessage(postId, timeoutMs, lastPost, lastError),
        {
          postId,
          timeoutMs,
          operation,
          lastStatus: lastPost?.status,
          lastPost,
          lastError,
        },
      ),
    );
  }
}

/**
 * The post statuses this SDK documents. A forward-compatible status the server
 * sends later is reported as unrecognized instead of being echoed.
 */
const KNOWN_POST_STATUSES: ReadonlySet<string> = new Set([
  "scheduled",
  "queued",
  "publishing",
  "published",
  "partial",
  "failed",
]);

function waitTimeoutMessage(
  postId: string,
  timeoutMs: number,
  lastPost: PostDetail | undefined,
  lastError: SyndrooError | undefined,
): string {
  const observed =
    lastPost === undefined
      ? "no status was observed"
      : `the last observed status was ${describePostStatus(lastPost.status)}`;
  const failure =
    lastError === undefined ? "" : ` The last status read failed with: ${lastError.message}`;

  return (
    `Stopped waiting for post ${postId} after ${timeoutMs}ms: ${observed}. ` +
    "Waiting only reads, so no post was created or cancelled and the server-side " +
    "work continues; resume with posts.get or a longer posts.wait." +
    failure
  );
}

function describePostStatus(status: string): string {
  return KNOWN_POST_STATUSES.has(status)
    ? `"${status}"`
    : "not one this SDK recognizes";
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

/**
 * Only the SDK's own errors are safe to keep. Anything else is dropped whole:
 * a raw failure can carry a URL, a provider message, or an abort reason.
 */
function toSyndrooError(error: unknown, errors: ErrorSink): SyndrooError {
  if (errors.has(error)) {
    return error;
  }

  return new SyndrooError("The status read failed with an unexpected error.", {
    code: "UNKNOWN",
    operation: "posts.wait",
  });
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
    throw configError(
      `maxResponseBytes must be an integer of at least ${MIN_MAX_RESPONSE_BYTES} bytes.`,
    );
  }

  return { baseUrl, apiKey, timeoutMs, maxResponseBytes };
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(
      "baseUrl is required, for example https://syndroo.example.com.",
    );
  }

  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw configError(
      "baseUrl must be an absolute URL, for example https://syndroo.example.com.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configError("baseUrl must use http or https.");
  }

  if (url.username !== "" || url.password !== "") {
    throw configError(
      "baseUrl must not embed credentials; pass the API key as apiKey so it is sent only as a Bearer header.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw configError(
      "baseUrl must not include a query string or fragment.",
    );
  }

  if (
    url.protocol === "http:" &&
    !allowInsecureHttp &&
    !isLoopbackHost(url.hostname)
  ) {
    throw configError(
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
    throw configError(
      "apiKey is required. Keep it in a server, CLI, or CI credential store, " +
        "never in client-side code or a NEXT_PUBLIC_* variable.",
    );
  }

  if (/[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw configError(
      "apiKey must not contain whitespace, line breaks, or control characters: " +
        "an Authorization header value cannot carry them.",
    );
  }

  return value;
}

/**
 * Errors built by one SDK call are registered in that call's own sink, so a
 * hostile fetch, body, or abort signal cannot smuggle an error of the same
 * class — or a mutated error from an earlier call — past the boundary.
 */
function configError(
  message: string,
  init: {
    operation?: SdkOperation | undefined;
    errors?: ErrorSink | undefined;
  } = {},
): SyndrooConfigError {
  const error = new SyndrooConfigError(message, { operation: init.operation });

  return init.errors === undefined ? error : init.errors.mark(error);
}

function validationError(
  message: string,
  init: { operation: SdkOperation; errors?: ErrorSink | undefined },
): SyndrooValidationError {
  const error = new SyndrooValidationError(message, {
    operation: init.operation,
  });

  return init.errors === undefined ? error : init.errors.mark(error);
}

function validatePositiveDuration(
  value: number,
  label: string,
  operation?: SdkOperation,
  errors?: ErrorSink,
): void {
  const message = durationError(value, label);

  if (message !== undefined) {
    throw configError(message, { operation, errors });
  }
}

/**
 * A per-call deadline is caller input, so it is rejected before any request or
 * timer exists. The bound itself lives in `http.ts`, so the transport and the
 * client cannot disagree about what Node's timers accept.
 */
function validateRequestDuration(
  value: number | undefined,
  label: string,
  operation: SdkOperation,
  errors: ErrorSink,
): void {
  if (value !== undefined) {
    validatePositiveDuration(value, label, operation, errors);
  }
}

function validateCreateInput(
  input: CreatePostInput,
  operation: SdkOperation,
  errors: ErrorSink,
): void {
  if (input === null || typeof input !== "object") {
    throw validationError(
      "A post requires a content string and a list of platforms.",
      { operation, errors },
    );
  }

  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw validationError("content must be a non-empty string.", {
      operation,
      errors,
    });
  }

  if (!Array.isArray(input.platforms) || input.platforms.length === 0) {
    throw validationError(
      "platforms must be a non-empty array of platform names.",
      { operation, errors },
    );
  }

  input.platforms.forEach((platform, index) => {
    if (typeof platform !== "string" || platform.trim().length === 0) {
      throw validationError(
        `platforms[${index}] must be a non-empty string.`,
        { operation, errors },
      );
    }
  });

  if (input.scheduledAt !== undefined) {
    if (
      typeof input.scheduledAt !== "string" ||
      Number.isNaN(Date.parse(input.scheduledAt))
    ) {
      throw validationError(
        "scheduledAt must be an ISO 8601 date-time string with an explicit " +
          "offset, for example 2030-01-02T03:04:05.000Z.",
        { operation, errors },
      );
    }
  }

  const overrides: Record<string, PostOverride> | undefined = input.overrides;

  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== "object") {
      throw validationError(
        "overrides must be an object keyed by platform name.",
        { operation, errors },
      );
    }

    for (const override of Object.values(overrides)) {
      if (override === null || typeof override !== "object") {
        throw validationError(
          "each overrides entry must be an object with an optional content string.",
          { operation, errors },
        );
      }

      const content: unknown = override.content;

      if (content !== undefined && typeof content !== "string") {
        throw validationError(
          "an overrides content must be a string.",
          { operation, errors },
        );
      }
    }
  }
}

function validateIdempotencyKey(
  value: string,
  operation: SdkOperation,
  errors: ErrorSink,
): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw validationError(
      "idempotencyKey must use 1-128 letters, digits, dots, underscores, colons, " +
        "or hyphens, and must be reused for the same logical post.",
      { operation, errors },
    );
  }

  return value;
}

function validatePostId(
  value: string,
  operation: SdkOperation,
  errors: ErrorSink,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw validationError("A post id is required.", { operation, errors });
  }

  return value;
}

function validateLimit(
  value: number,
  operation: SdkOperation,
  errors: ErrorSink,
): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw validationError(
      "limit must be an integer between 1 and 100.",
      { operation, errors },
    );
  }

  return value;
}

function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  operation: SdkOperation,
  errors: ErrorSink,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        errors.mark(
          new SyndrooAbortError(
            "Waiting was aborted before the next status read. Nothing was created or cancelled.",
            { operation },
          ),
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
        errors.mark(
          new SyndrooAbortError(
            "Waiting was aborted. Nothing was created or cancelled; the post continues on the server.",
            { operation },
          ),
        ),
      );
    };

    function finish(): void {
      clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
