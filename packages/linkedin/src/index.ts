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

const POSTS_URL = "https://api.linkedin.com/rest/posts";
const MAX_ESCAPED_UTF16_UNITS = 3000;
const MAX_CONFIRMATION_BYTES = 8 * 1024;

export interface LinkedInPublisherOptions {
  accessToken: string;
  author: string;
  apiVersion: string;
  timeoutMs?: number;
}

/** Exact typed credential the LinkedIn publisher needs. */
export interface LinkedInCredential {
  readonly accessToken: string;
  readonly author: string;
  readonly apiVersion: string;
}

export function isLinkedInConfigurationValid(
  accessToken: string | undefined,
  author: string | undefined,
  apiVersion: string | undefined,
): boolean {
  return Boolean(
    accessToken &&
      /^[\x21-\x7e]+$/.test(accessToken) &&
      author &&
      /^(?:urn:li:person:[A-Za-z0-9_-]+|urn:li:organization:[1-9][0-9]*)$/.test(author) &&
      apiVersion &&
      /^20\d{2}(?:0[1-9]|1[0-2])$/.test(apiVersion),
  );
}

/**
 * Typed decoder for a LinkedIn credential record.
 *
 * The API version is required rather than defaulted here: design §7.2 forbids a
 * magic version hidden in a factory. It validates only the supplied record and
 * never borrows a token, author, or version from another source.
 */
export function decodeLinkedInCredential(input: unknown): LinkedInCredential {
  const record = asRecord(input);
  const accessToken = readString(record, "access_token");
  const author = readString(record, "author");
  const apiVersion = readString(record, "api_version");

  if (!isLinkedInConfigurationValid(accessToken, author, apiVersion)) {
    throw new PublishError(
      "LinkedIn credential is incomplete (access_token, author, api_version)",
      "AUTH",
    );
  }

  return {
    accessToken: accessToken as string,
    author: author as string,
    apiVersion: apiVersion as string,
  };
}

/** Pure construction: no network, no credential resolution, no side effects. */
export function buildLinkedInPublisher(
  credential: LinkedInCredential,
  config: Omit<LinkedInPublisherOptions, "accessToken" | "author" | "apiVersion"> = {},
): LinkedInPublisher {
  return new LinkedInPublisher({ ...config, ...credential });
}

// Posts commentary uses LinkedIn's "little" grammar, not raw plain text.
// Escape every reserved character so user text cannot introduce mentions or
// formatting, or be truncated by unbalanced delimiters. JSON escaping follows.
function plainCommentary(text: string): string {
  return text.replace(/[|{}@\[\]()<>#\\*_~]/g, "\\$&");
}

export class LinkedInPublisher implements Publisher {
  readonly name = "linkedin-native";

  private readonly accessToken: string;
  private readonly author: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(options: LinkedInPublisherOptions) {
    if (!isLinkedInConfigurationValid(options.accessToken, options.author, options.apiVersion)) {
      throw new TypeError("LinkedIn requires an access token, author URN, and YYYYMM API version");
    }

    this.accessToken = options.accessToken;
    this.author = options.author;
    this.apiVersion = options.apiVersion;
    this.timeoutMs = options.timeoutMs ?? 15_000;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("LinkedIn timeout must be positive");
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    // Conservative UTF-16 limit includes the little-text escape characters.
    // Do not truncate user text or rely on a provider-side validation request.
    const commentary = plainCommentary(request.content);

    if (
      request.platform !== "linkedin" ||
      !request.content.trim() ||
      commentary.length > MAX_ESCAPED_UTF16_UNITS ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(request.content)
    ) {
      throw new PublishError(
        "LinkedIn requires plain text within 3000 escaped UTF-16 units",
        "INVALID_CONTENT",
      );
    }

    let response;

    try {
      response = await boundedRequest({
        url: POSTS_URL,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "LinkedIn-Version": this.apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: this.author,
          commentary,
          visibility: "PUBLIC",
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_CONFIRMATION_BYTES,
        // Creation is confirmed by status plus `x-restli-id`; the body is never
        // buffered and a stalled stream is released without being awaited.
        bodyPolicy: "discard",
      });
    } catch (error) {
      throw toPublishError(error);
    }

    if (response.status !== 201) {
      throw classifyStatus(
        response.status,
        response.headers.get("retry-after"),
        new Date(),
      );
    }

    const header = response.headers.get("x-restli-id");
    let id = "";

    if (header !== null && header.length <= 256) {
      try {
        id = decodeURIComponent(header);
      } catch {
        // An undecodable header stays unconfirmed.
      }
    }

    if (!/^urn:li:(?:share|ugcPost):[1-9][0-9]*$/.test(id)) {
      throw new PublishError(
        "LinkedIn response did not confirm a valid post ID",
        "UNKNOWN",
        true,
      );
    }

    return {
      externalId: id,
      externalUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/`,
    };
  }
}

function classifyStatus(
  status: number,
  retryAfter: string | null,
  now: Date,
): PublishError {
  const message = `LinkedIn request failed (HTTP ${status})`;

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

function toPublishError(error: unknown): PublishError {
  if (error instanceof TransportError) {
    // The single POST is the write: once `fetch` started, an unknown outcome is
    // never retried automatically and is reported as ambiguous.
    if (error.code === "network" || error.code === "timeout" || error.code === "aborted") {
      return new PublishError(
        "LinkedIn request was interrupted",
        "NETWORK",
        error.requestDispatched,
      );
    }

    return new PublishError(
      "LinkedIn request was not completed",
      "UNKNOWN",
      error.requestDispatched,
    );
  }

  return new PublishError("LinkedIn publishing failed", "UNKNOWN", true);
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

export const linkedinAdapter: PlatformAdapter = {
  providerName: "linkedin-native",

  buildPublisher: (cred) => buildLinkedInPublisher(decodeLinkedInCredential(cred)),

  oauth: {
    type: "oauth2",
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: "w_member_social openid profile",
  },
};
