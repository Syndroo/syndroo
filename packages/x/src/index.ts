import { Client, HttpClient, OAuth1, type HttpClientRequestOptions } from "@xdevplatform/xdk";
import twitterText from "twitter-text";
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

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface XPublisherOptions {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  timeoutMs?: number;
}

/** What a user or agent can supply directly: no app consumer keys. */
export interface XUserCredential {
  readonly accessToken: string;
  readonly accessTokenSecret: string;
}

/** Exact typed credential the X publisher needs (app keys + user tokens). */
export interface XCredential extends XUserCredential {
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * Typed decoder for a direct user credential.
 *
 * Consumer key and secret stay runtime app secrets: a missing user token is
 * never completed from them, and this decoder must not be used as the resolved
 * publishing credential.
 */
export function decodeXUserCredential(input: unknown): XUserCredential {
  const record = asRecord(input);
  const accessToken = readString(record, "access_token");
  const accessTokenSecret = readString(record, "access_token_secret");

  if (!accessToken || !accessTokenSecret) {
    throw new PublishError(
      "X user credential is incomplete (access_token, access_token_secret)",
      "AUTH",
    );
  }

  return { accessToken, accessTokenSecret };
}

/** Typed decoder for the resolved publishing credential (app + user). */
export function decodeXCredential(input: unknown): XCredential {
  const record = asRecord(input);
  const apiKey = readString(record, "api_key");
  const apiSecret = readString(record, "api_secret");
  const user = decodeXUserCredential(input);

  if (!apiKey || !apiSecret) {
    throw new PublishError(
      "X credential is incomplete (api_key, api_secret, access_token, access_token_secret)",
      "AUTH",
    );
  }

  return { apiKey, apiSecret, accessToken: user.accessToken, accessTokenSecret: user.accessTokenSecret };
}

/** Pure construction: no network, no credential resolution, no side effects. */
export function buildXPublisher(
  credential: XCredential,
  config: Pick<XPublisherOptions, "timeoutMs"> = {},
): XPublisher {
  return new XPublisher({ ...config, ...credential });
}

// The SDK shares its default transport and create() does not forward request
// options. Override only the transport, per instance, to bound the entire body
// read and avoid mutating the SDK singleton or global fetch. The SDK's own
// retry machinery is disabled by `Client({ retry: false })`.
class PublishingTransport extends HttpClient {
  failure?: PublishError;
  started = false;

  constructor(private readonly timeoutMs: number) {
    super();
  }

  override async request(
    url: string,
    options: HttpClientRequestOptions = {},
  ): Promise<Response> {
    if (typeof options.body !== "string") {
      throw new PublishError("X publishing requires a JSON request body", "UNKNOWN");
    }

    try {
      this.started = true;
      const response = await boundedRequest({
        url,
        method: options.method === "GET" ? "GET" : "POST",
        headers: headerRecord(options.headers),
        body: options.body,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });

      if (!response.ok) {
        throw classifyStatus(
          response.status,
          response.headers.get("retry-after"),
          new Date(),
        );
      }

      // Preserve a malformed success as UNKNOWN/ambiguous, not SDK NETWORK.
      try {
        JSON.parse(response.text() === "" ? "null" : response.text());
      } catch {
        throw new PublishError("X returned invalid JSON", "UNKNOWN", true);
      }

      return response.toResponse();
    } catch (error) {
      this.failure =
        error instanceof PublishError
          ? error
          : toPublishError(error);
      throw this.failure;
    }
  }
}

function classifyStatus(
  status: number,
  retryAfter: string | null,
  now: Date,
): PublishError {
  const message = `X request failed (HTTP ${status})`;

  if (status === 401 || status === 403) {
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

// A transport-level failure on this single-write endpoint may follow an
// accepted write, so it stays ambiguous.
function toPublishError(error: unknown): PublishError {
  if (error instanceof TransportError) {
    if (error.code === "response_too_large") {
      return new PublishError("X response exceeded size limit", "UNKNOWN", true);
    }

    if (error.code === "redirect" || error.code === "invalid_target") {
      // A refused redirect never performed the write at the provider.
      return new PublishError("X request was not completed", "UNKNOWN", true);
    }

    return new PublishError("X request or response was interrupted", "NETWORK", true);
  }

  return new PublishError("X SDK publishing failed", "UNKNOWN", true);
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  return headers === undefined ? {} : Object.fromEntries(new Headers(headers));
}

class PublishingClient extends Client {
  override readonly httpClient: PublishingTransport;

  constructor(options: XPublisherOptions) {
    // No OAuth negotiation occurs here; credentials have already been issued.
    super({ oauth1: new OAuth1({ ...options, callback: "oob" }), retry: false });
    this.httpClient = new PublishingTransport(options.timeoutMs ?? 15_000);
  }
}

export class XPublisher implements Publisher {
  readonly name = "x-sdk";

  private readonly options: XPublisherOptions;

  constructor(options: XPublisherOptions) {
    if (
      ![options.apiKey, options.apiSecret, options.accessToken, options.accessTokenSecret].every(
        value => typeof value === "string" && value.trim().length > 0,
      )
    ) {
      throw new TypeError("All four X OAuth 1.0a credentials are required");
    }

    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new TypeError("X timeout must be positive");
    }

    // Copy and freeze so a later caller mutation cannot swap the account or
    // secret used by an already-constructed publisher.
    this.options = Object.freeze({ ...options });
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const text = request.content.normalize("NFC");

    if (request.platform !== "x" || !text.trim() || !twitterText.parseTweet(text).valid) {
      throw new PublishError(
        "X requires valid text within the 280 weighted-character limit",
        "INVALID_CONTENT",
      );
    }

    const client = new PublishingClient(this.options);

    try {
      const result = await client.posts.create({ text });
      const id = result?.data?.id;

      if (typeof id !== "string" || !/^\d+$/.test(id)) {
        throw new PublishError("X response did not include a valid post ID", "UNKNOWN", true);
      }

      return { externalId: id, externalUrl: `https://x.com/i/web/status/${id}` };
    } catch (error) {
      if (client.httpClient.failure) {
        throw client.httpClient.failure;
      }

      if (error instanceof PublishError) {
        throw error;
      }

      // SDK response parsing errors may follow an accepted write. Do not expose
      // SDK error details, which can contain request data or credentials.
      throw toPublishError(error);
    }
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

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

export const xAdapter: PlatformAdapter = {
  providerName: "x-sdk",

  buildPublisher: (cred) => buildXPublisher(decodeXCredential(cred)),

  oauth: {
    type: "oauth1",
    requestTokenUrl: "https://api.twitter.com/oauth/request_token",
    authorizeUrl: "https://api.twitter.com/oauth/authorize",
    accessTokenUrl: "https://api.twitter.com/oauth/access_token",
  },
};
