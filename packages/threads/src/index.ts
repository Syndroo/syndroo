import {
  PublishError,
  type PlatformAdapter,
  type Publisher,
  type PublishRequest,
  type PublishResult,
} from "@syndroo/core";
import {
  TransportError,
  boundedRequest,
  parseRetryAfter,
} from "@syndroo/transport";

const DEFAULT_API_BASE_URL = "https://graph.threads.net";
const MAX_POST_CODE_POINTS = 500;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ThreadsPublisherOptions {
  accessToken: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

/** Exact typed credential the Threads publisher needs. */
export interface ThreadsCredential {
  readonly accessToken: string;
}

/**
 * Typed decoder for a Threads credential record.
 *
 * It validates only what the caller passed in: a missing access token is never
 * filled from another source, so a partially configured deployment fails closed
 * instead of publishing through an unintended account.
 */
export function decodeThreadsCredential(input: unknown): ThreadsCredential {
  const record = asRecord(input);
  const accessToken =
    typeof record?.["access_token"] === "string"
      ? record["access_token"].trim()
      : "";

  if (!accessToken) {
    throw new PublishError(
      "Threads credential is incomplete (access_token)",
      "AUTH",
    );
  }

  return { accessToken };
}

/** Pure construction: no network, no credential resolution, no side effects. */
export function buildThreadsPublisher(
  credential: ThreadsCredential,
  config: Omit<ThreadsPublisherOptions, "accessToken"> = {},
): ThreadsPublisher {
  return new ThreadsPublisher({ ...config, accessToken: credential.accessToken });
}

export class ThreadsPublisher implements Publisher {
  readonly name = "threads-native";

  private readonly accessToken: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ThreadsPublisherOptions) {
    if (typeof options.accessToken !== "string" || !options.accessToken.trim()) {
      throw new TypeError("Threads access token is required");
    }

    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new TypeError("Threads timeout must be positive");
    }

    this.accessToken = options.accessToken;
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.platform !== "threads") {
      throw new PublishError(
        `Threads publisher does not support platform: ${request.platform}`,
        "INVALID_CONTENT",
      );
    }

    if (!request.content.trim()) {
      throw new PublishError("Threads content must not be empty", "INVALID_CONTENT");
    }

    if ([...request.content].length > MAX_POST_CODE_POINTS) {
      throw new PublishError("Threads content exceeds post limits", "INVALID_CONTENT");
    }

    let response;

    try {
      response = await boundedRequest({
        url: `${this.apiBaseUrl}/me/threads`,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          media_type: "TEXT",
          text: request.content,
          auto_publish_text: "true",
        }),
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      // The single POST is the write: a dispatched attempt may already have
      // created a post, so it stays ambiguous. Nothing is retried here.
      throw toPublishError(error);
    }

    if (!response.ok) {
      throw classifyStatus(
        response.status,
        response.headers.get("retry-after"),
        new Date(),
      );
    }

    const responseBody = parseJson(response.text());

    if (!isRecord(responseBody) || typeof responseBody.id !== "string") {
      throw new PublishError(
        "Threads response did not include a post ID",
        "UNKNOWN",
        true,
      );
    }

    return { externalId: responseBody.id };
  }
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Threads API base URL must be a clean HTTPS URL");
  }

  return url.toString().replace(/\/$/, "");
}

function classifyStatus(
  status: number,
  retryAfter: string | null,
  now: Date,
): PublishError {
  if (status === 401 || status === 403) {
    return new PublishError("Threads request failed (HTTP 401 or 403)", "AUTH");
  }

  if (status === 429) {
    // An explicit 429 rejection is the only place a Retry-After hint is trusted.
    const retryAfterAt = parseRetryAfter(retryAfter, { now });
    return new PublishError(
      "Threads request failed (HTTP 429)",
      "RATE_LIMIT",
      false,
      retryAfterAt === undefined ? undefined : { retryAfterAt },
    );
  }

  if (status === 400 || status === 413 || status === 422) {
    return new PublishError("Threads request failed (HTTP 400, 413 or 422)", "INVALID_CONTENT");
  }

  if (status >= 500) {
    return new PublishError(
      `Threads request failed (HTTP ${status})`,
      "PROVIDER_UNAVAILABLE",
      true,
    );
  }

  return new PublishError(`Threads request failed (HTTP ${status})`, "UNKNOWN", true);
}

function toPublishError(error: unknown): PublishError {
  if (error instanceof TransportError) {
    // `requestDispatched` is only the observable fetch-start fact; for this
    // single-write protocol anything after that point stays ambiguous.
    const ambiguous = error.requestDispatched;

    if (error.code === "network" || error.code === "timeout" || error.code === "aborted") {
      return new PublishError("Threads request was interrupted", "NETWORK", ambiguous);
    }

    if (error.code === "response_too_large") {
      return new PublishError(
        "Threads response exceeded size limit",
        "UNKNOWN",
        ambiguous,
      );
    }

    return new PublishError("Threads request was not completed", "UNKNOWN", ambiguous);
  }

  // Nothing from the runtime or the provider is attached as a cause.
  return new PublishError("Threads publishing failed", "UNKNOWN", true);
}

function parseJson(text: string): unknown {
  if (text === "") {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PublishError("Threads returned invalid JSON", "UNKNOWN", true);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

export const threadsAdapter: PlatformAdapter = {
  providerName: "threads-native",

  buildPublisher: (cred) => buildThreadsPublisher(decodeThreadsCredential(cred)),
};
