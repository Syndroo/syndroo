export const PLATFORMS = [
  "x",
  "threads",
  "bluesky",
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
