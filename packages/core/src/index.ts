export const PLATFORMS = [
  "x",
  "threads",
  "bluesky",
  "tumblr",
  "mastodon",
  "linkedin",
  "nostr",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORMS.includes(value as Platform);
}

export interface CreatePostInput {
  content: string;
  platforms: Platform[];
  overrides?: Partial<Record<Platform, { content?: string }>>;
  scheduledAt?: string;
}

export interface Post extends CreatePostInput {
  id: string;
  status: PostStatus;
  createdAt: string;
}

export type PostStatus =
  | "scheduled"
  | "queued"
  | "publishing"
  | "published"
  | "partial"
  | "failed";

export type PublicationStatus =
  | "scheduled"
  | "pending"
  | "publishing"
  | "published"
  | "failed";

export interface Publication {
  id: string;
  postId: string;
  platform: Platform;
  provider: string;
  content: string;
  status: PublicationStatus;
  attempts: number;
  externalId?: string;
  externalUrl?: string;
  errorCode?: PublishErrorCode;
  errorMessage?: string;
  errorAmbiguous?: boolean;
  scheduledAt?: string;
  enqueuedAt?: string;
  publishingAt?: string;
  createdAt: string;
  publishedAt?: string;
}

export interface PublicationJob {
  publicationId: string;
}

export interface PublishRequest {
  publicationId: string;
  platform: Platform;
  content: string;
}

export interface PublishResult {
  externalId?: string;
  externalUrl?: string;
}

export interface Publisher {
  readonly name: string;
  publish(request: PublishRequest): Promise<PublishResult>;
}

export type PublishErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "INVALID_CONTENT"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK"
  | "UNKNOWN";

export class PublishError extends Error {
  constructor(
    message: string,
    public readonly code: PublishErrorCode,
    public readonly ambiguous = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublishError";
  }
}

// ---------------------------------------------------------------------------
// Platform adapter contracts
// ---------------------------------------------------------------------------

/** OAuth 1.0a endpoint configuration (platform-owned, no runtime dependencies). */
export interface OAuth1Endpoints {
  readonly type: "oauth1";
  readonly requestTokenUrl: string;
  readonly authorizeUrl: string;
  readonly accessTokenUrl: string;
  /**
   * Map additional fields from the access-token response body into the stored
   * credential (e.g. `blog_name` for Tumblr).
   */
  parseExtraCredentials?(params: URLSearchParams): Record<string, string>;
}

/** OAuth 2.0 authorization-code endpoint configuration. */
export interface OAuth2Endpoints {
  readonly type: "oauth2";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: string;
}

export type OAuthEndpoints = OAuth1Endpoints | OAuth2Endpoints;

/**
 * Platform-level adapter.  Each platform package exports one of these.
 * It is intentionally free of Cloudflare/Worker types so it can be tested
 * and reasoned about independently.
 *
 * Credential keys use snake_case strings so they round-trip cleanly through
 * D1 JSON storage without a separate mapping layer.
 */
export interface PlatformAdapter {
  /** Provider name written to `publications.provider`; part of the stored-data contract. */
  readonly providerName: string;
  /**
   * Build a Publisher from a fully-resolved credential record.
   * The Worker is responsible for merging env vars and D1 data into that
   * record before calling this method.
   * Throws `PublishError("AUTH")` if any required field is missing.
   */
  buildPublisher(credential: Record<string, string>): Publisher;
  /** OAuth endpoint configuration; absent when the platform uses direct token submission only. */
  readonly oauth?: OAuthEndpoints;
}
