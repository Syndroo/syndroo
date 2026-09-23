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
  oauth1AuthorizationHeader,
  parseRetryAfter,
} from "@syndroo/transport";

const MAX_POST_CODE_POINTS = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface TumblrPublisherOptions {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  blog: string;
  timeoutMs?: number;
}

/** What a user or agent can supply directly, before app credentials are added. */
export interface TumblrUserCredential {
  readonly token: string;
  readonly tokenSecret: string;
  readonly blog?: string;
}

/** Exact typed credential the Tumblr publisher needs (app credentials + user tokens). */
export interface TumblrCredential extends TumblrUserCredential {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly blog: string;
}

// Accept a Tumblr blog name or its tumblr.com hostname, never an arbitrary URL.
export function normalizeTumblrBlog(value: string): string {
  const name = value.trim().toLowerCase().replace(/\.tumblr\.com$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new TypeError("Tumblr blog must be a blog name or tumblr.com hostname");
  }
  return name;
}

/**
 * Typed decoder for a direct user credential.
 *
 * It carries no app credentials: consumer key and secret stay runtime secrets
 * owned by the composition root and must not be merged in from this input.
 */
export function decodeTumblrUserCredential(input: unknown): TumblrUserCredential {
  const record = asRecord(input);
  const token = readString(record, "token");
  const tokenSecret = readString(record, "token_secret");
  const blog = readString(record, "blog");

  if (!token || !tokenSecret) {
    throw new PublishError(
      "Tumblr user credential is incomplete (token, token_secret)",
      "AUTH",
    );
  }

  return { token, tokenSecret, ...(blog === undefined ? {} : { blog }) };
}

/**
 * Typed decoder for the resolved publishing credential (app + user).
 *
 * It validates the whole group it was given and never fills a missing user
 * token from environment app credentials.
 */
export function decodeTumblrCredential(input: unknown): TumblrCredential {
  const record = asRecord(input);
  const consumerKey = readString(record, "consumer_key");
  const consumerSecret = readString(record, "consumer_secret");
  const user = decodeTumblrUserCredential(input);
  const blog = user.blog;

  if (!consumerKey || !consumerSecret || blog === undefined) {
    throw new PublishError(
      "Tumblr credential is incomplete (consumer_key, consumer_secret, token, token_secret, blog)",
      "AUTH",
    );
  }

  return { consumerKey, consumerSecret, token: user.token, tokenSecret: user.tokenSecret, blog };
}

/** Pure construction: no network, no credential resolution, no side effects. */
export function buildTumblrPublisher(
  credential: TumblrCredential,
  config: Pick<TumblrPublisherOptions, "timeoutMs"> = {},
): TumblrPublisher {
  return new TumblrPublisher({ ...config, ...credential });
}

export class TumblrPublisher implements Publisher {
  readonly name = "tumblr-native";

  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly token: string;
  private readonly tokenSecret: string;
  private readonly blog: string;
  private readonly timeoutMs: number;

  constructor(options: TumblrPublisherOptions) {
    if (
      ![options.consumerKey, options.consumerSecret, options.token, options.tokenSecret].every(
        value => typeof value === "string" && value.trim(),
      )
    ) {
      throw new TypeError("All four Tumblr OAuth credentials are required");
    }

    this.blog = normalizeTumblrBlog(options.blog);
    this.timeoutMs = options.timeoutMs ?? 15_000;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("Tumblr timeout must be positive");
    }

    this.consumerKey = options.consumerKey;
    this.consumerSecret = options.consumerSecret;
    this.token = options.token;
    this.tokenSecret = options.tokenSecret;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    // v0.1 intentionally uses one NPF text block, not HTML or Markdown.
    if (
      request.platform !== "tumblr" ||
      !request.content.trim() ||
      [...request.content].length > MAX_POST_CODE_POINTS
    ) {
      throw new PublishError(
        "Tumblr requires text within 4096 Unicode code points",
        "INVALID_CONTENT",
      );
    }

    const url = `https://api.tumblr.com/v2/blog/${this.blog}.tumblr.com/posts`;
    let authorization: string;

    try {
      authorization = await oauth1AuthorizationHeader({
        method: "POST",
        url,
        consumerKey: this.consumerKey,
        consumerSecret: this.consumerSecret,
        token: this.token,
        tokenSecret: this.tokenSecret,
        nonce: crypto.randomUUID().replaceAll("-", ""),
        timestamp: String(Math.floor(Date.now() / 1000)),
      });
    } catch {
      throw new PublishError("Tumblr request signing failed", "UNKNOWN");
    }

    let response;

    try {
      response = await boundedRequest({
        url,
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          state: "published",
          send_to_twitter: false,
          content: [{ type: "text", text: request.content }],
        }),
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      throw toPublishError(error);
    }

    if (!response.ok) {
      throw classifyStatus(
        response.status,
        response.headers.get("retry-after"),
        new Date(),
      );
    }

    const body = parseJson(response.text());

    if (
      !isRecord(body) ||
      !isRecord(body.meta) ||
      body.meta.status !== 201 ||
      response.status !== 201 ||
      !isRecord(body.response) ||
      typeof body.response.id !== "string" ||
      !/^\d+$/.test(body.response.id)
    ) {
      throw new PublishError(
        "Tumblr response did not confirm a created post",
        "UNKNOWN",
        true,
      );
    }

    return {
      externalId: body.response.id,
      externalUrl: `https://${this.blog}.tumblr.com/post/${body.response.id}`,
    };
  }
}

function classifyStatus(
  status: number,
  retryAfter: string | null,
  now: Date,
): PublishError {
  const message = `Tumblr request failed (HTTP ${status})`;

  if (status === 401 || status === 403 || status === 404) {
    return new PublishError(message, "AUTH", false);
  }

  if (status === 429) {
    const retryAfterAt = parseRetryAfter(retryAfter, { now });
    return new PublishError(
      message,
      "RATE_LIMIT",
      false,
      retryAfterAt === undefined ? undefined : { retryAfterAt },
    );
  }

  if (status === 400 || status === 413 || status === 422) {
    return new PublishError(message, "INVALID_CONTENT", false);
  }

  if (status >= 500) {
    return new PublishError(message, "PROVIDER_UNAVAILABLE", true);
  }

  return new PublishError(message, "UNKNOWN", true);
}

function toPublishError(error: unknown): PublishError {
  if (error instanceof TransportError) {
    // The single POST is the write; anything after dispatch stays ambiguous.
    const ambiguous = error.requestDispatched;

    if (error.code === "network" || error.code === "timeout" || error.code === "aborted") {
      return new PublishError(
        "Tumblr request or response was interrupted",
        "NETWORK",
        ambiguous,
      );
    }

    if (error.code === "response_too_large") {
      return new PublishError(
        "Tumblr response exceeded size limit",
        "UNKNOWN",
        ambiguous,
      );
    }

    return new PublishError("Tumblr request was not completed", "UNKNOWN", ambiguous);
  }

  return new PublishError("Tumblr request or response was interrupted", "NETWORK", true);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PublishError("Tumblr returned invalid JSON", "UNKNOWN", true);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

export const tumblrAdapter: PlatformAdapter = {
  providerName: "tumblr-native",

  buildPublisher: (cred) => buildTumblrPublisher(decodeTumblrCredential(cred)),

  oauth: {
    type: "oauth1",
    requestTokenUrl: "https://www.tumblr.com/oauth/request_token",
    authorizeUrl: "https://www.tumblr.com/oauth/authorize",
    accessTokenUrl: "https://www.tumblr.com/oauth/access_token",
    parseExtraCredentials: (params) => {
      const blog = params.get("blog_name");
      return blog ? { blog } : {};
    },
  },
};
