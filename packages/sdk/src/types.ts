/**
 * Wire types and narrow runtime readers for the documented Syndroo HTTP
 * contract (see the "HTTP API" section of the repository README).
 *
 * These declarations are intentionally independent of the private
 * `@syndroo/core` workspace package: the published SDK must keep zero runtime
 * dependencies, and the server contract — not the internal domain model — is
 * what users depend on.
 */

import { SyndrooResponseError, truncate } from "./errors.js";

/** Platforms the docs describe today. The SDK accepts any string the server accepts. */
export type KnownPlatform =
  | "x"
  | "threads"
  | "bluesky"
  | "tumblr"
  | "mastodon"
  | "linkedin"
  | "nostr";

/**
 * Literal-union helper: editors still complete the documented names, while a
 * value the server adds later does not become a type error for consumers.
 */
export type SupportsFutureValues<T extends string> = T | (string & {});

export type Platform = SupportsFutureValues<KnownPlatform>;

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

export type PublishErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "INVALID_CONTENT"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK"
  | "UNKNOWN";

export interface PostOverride {
  content?: string;
}

/** The request body of `POST /v1/posts`, passed through unchanged. */
export interface CreatePostInput {
  content: string;
  platforms: Platform[];
  overrides?: Record<string, PostOverride>;
  scheduledAt?: string;
}

/**
 * The acceptance receipt for `POST /v1/posts`. HTTP `202` means the request was
 * accepted for processing; it is not a delivery result. Read the post (and each
 * publication) before claiming that anything reached a platform.
 */
export interface PostReceipt {
  id: string;
  status: SupportsFutureValues<PostStatus>;
  scheduledAt?: string;
  enqueueDeferred?: boolean;
  replayed?: boolean;
}

export interface PostSummary {
  id: string;
  content: string;
  platforms: Platform[];
  status: SupportsFutureValues<PostStatus>;
  createdAt: string;
  scheduledAt?: string;
  overrides?: Record<string, PostOverride>;
}

export interface Publication {
  id: string;
  postId: string;
  platform: Platform;
  provider: string;
  content: string;
  status: SupportsFutureValues<PublicationStatus>;
  attempts: number;
  errorAmbiguous?: boolean;
  externalId?: string;
  externalUrl?: string;
  errorCode?: SupportsFutureValues<PublishErrorCode>;
  errorMessage?: string;
  createdAt?: string;
  scheduledAt?: string;
  enqueuedAt?: string;
  publishingAt?: string;
  publishedAt?: string;
}

export interface PostDetail extends PostSummary {
  publications: Publication[];
}

export interface HealthStatus {
  status: string;
}

/** Context attached to a parse failure so callers know what Syndroo answered. */
export interface ParseContext {
  status?: number | undefined;
  requestMayHaveBeenApplied?: boolean | undefined;
}

const TERMINAL_POST_STATUSES: ReadonlySet<string> = new Set([
  "published",
  "partial",
  "failed",
]);

/** `published`, `partial`, and `failed` stop changing without a new request. */
export function isPostTerminal(status: string): boolean {
  return TERMINAL_POST_STATUSES.has(status);
}

/** Every selected platform succeeded. Anything else is not a delivery. */
export function isPostDelivered(status: string): boolean {
  return status === "published";
}

export function parsePostReceipt(
  value: unknown,
  context: ParseContext = {},
): PostReceipt {
  const record = requireRecord(value, "the create response");
  const receipt: PostReceipt = {
    id: requireString(record["id"], "create response id", context),
    status: requireString(record["status"], "create response status", context),
  };
  assignOptional(receipt, "scheduledAt", optionalString(record["scheduledAt"], "create response scheduledAt", context));
  assignOptional(receipt, "enqueueDeferred", optionalBoolean(record["enqueueDeferred"], "create response enqueueDeferred", context));
  assignOptional(receipt, "replayed", optionalBoolean(record["replayed"], "create response replayed", context));
  return receipt;
}

export function parsePostSummary(
  value: unknown,
  context: ParseContext = {},
  label = "post",
): PostSummary {
  const record = requireRecord(value, label, context);
  const summary: PostSummary = {
    id: requireString(record["id"], `${label} id`, context),
    content: requireString(record["content"], `${label} content`, context),
    platforms: requireArray(record["platforms"], `${label} platforms`, context).map(
      (platform, index) =>
        requireString(platform, `${label} platforms[${index}]`, context),
    ),
    status: requireString(record["status"], `${label} status`, context),
    createdAt: requireString(record["createdAt"], `${label} createdAt`, context),
  };
  assignOptional(summary, "scheduledAt", optionalString(record["scheduledAt"], `${label} scheduledAt`, context));
  assignOptional(summary, "overrides", optionalOverrides(record["overrides"], `${label} overrides`, context));
  return summary;
}

export function parsePostDetail(
  value: unknown,
  context: ParseContext = {},
): PostDetail {
  const record = requireRecord(value, "post", context);
  const publications = requireArray(
    record["publications"],
    "post publications",
    context,
  ).map((item, index) => parsePublication(item, `post publications[${index}]`, context));

  return { ...parsePostSummary(record, context), publications };
}

export function parsePostList(
  value: unknown,
  context: ParseContext = {},
): PostSummary[] {
  const record = requireRecord(value, "the list response", context);
  return requireArray(record["items"], "list response items", context).map(
    (item, index) => parsePostSummary(item, context, `list response items[${index}]`),
  );
}

export function parseHealth(value: unknown, context: ParseContext = {}): HealthStatus {
  const record = requireRecord(value, "the health response", context);
  return { status: requireString(record["status"], "health response status", context) };
}

function parsePublication(
  value: unknown,
  label: string,
  context: ParseContext,
): Publication {
  const record = requireRecord(value, label, context);
  const publication: Publication = {
    id: requireString(record["id"], `${label} id`, context),
    postId: requireString(record["postId"], `${label} postId`, context),
    platform: requireString(record["platform"], `${label} platform`, context),
    provider: requireString(record["provider"], `${label} provider`, context),
    content: requireString(record["content"], `${label} content`, context),
    status: requireString(record["status"], `${label} status`, context),
    attempts: requireNumber(record["attempts"], `${label} attempts`, context),
  };
  assignOptional(publication, "errorAmbiguous", optionalBoolean(record["errorAmbiguous"], `${label} errorAmbiguous`, context));
  assignOptional(publication, "externalId", optionalString(record["externalId"], `${label} externalId`, context));
  assignOptional(publication, "externalUrl", optionalString(record["externalUrl"], `${label} externalUrl`, context));
  assignOptional(publication, "errorCode", optionalString(record["errorCode"], `${label} errorCode`, context));
  assignOptional(publication, "errorMessage", optionalString(record["errorMessage"], `${label} errorMessage`, context));
  assignOptional(publication, "createdAt", optionalString(record["createdAt"], `${label} createdAt`, context));
  assignOptional(publication, "scheduledAt", optionalString(record["scheduledAt"], `${label} scheduledAt`, context));
  assignOptional(publication, "enqueuedAt", optionalString(record["enqueuedAt"], `${label} enqueuedAt`, context));
  assignOptional(publication, "publishingAt", optionalString(record["publishingAt"], `${label} publishingAt`, context));
  assignOptional(publication, "publishedAt", optionalString(record["publishedAt"], `${label} publishedAt`, context));
  return publication;
}

function optionalOverrides(
  value: unknown,
  label: string,
  context: ParseContext,
): Record<string, PostOverride> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const record = requireRecord(value, label, context);
  const overrides: Record<string, PostOverride> = {};

  for (const [platform, override] of Object.entries(record)) {
    const entry = requireRecord(override, `${label}.${platform}`, context);
    const content = optionalString(entry["content"], `${label}.${platform}.content`, context);
    overrides[platform] = content === undefined ? {} : { content };
  }

  return overrides;
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function requireRecord(
  value: unknown,
  label: string,
  context: ParseContext = {},
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object, received ${describe(value)}`, context);
  }

  return value as Record<string, unknown>;
}

function requireArray(
  value: unknown,
  label: string,
  context: ParseContext = {},
): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${label} must be an array, received ${describe(value)}`, context);
  }

  return value;
}

function requireString(
  value: unknown,
  label: string,
  context: ParseContext = {},
): string {
  if (typeof value !== "string") {
    throw invalid(`${label} must be a string, received ${describe(value)}`, context);
  }

  return value;
}

function requireNumber(
  value: unknown,
  label: string,
  context: ParseContext = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${label} must be a number, received ${describe(value)}`, context);
  }

  return value;
}

function optionalString(
  value: unknown,
  label: string,
  context: ParseContext = {},
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireString(value, label, context);
}

function optionalBoolean(
  value: unknown,
  label: string,
  context: ParseContext = {},
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw invalid(`${label} must be a boolean, received ${describe(value)}`, context);
  }

  return value;
}

function invalid(message: string, context: ParseContext): SyndrooResponseError {
  return new SyndrooResponseError(
    `Syndroo returned a response that does not match the documented contract: ${message}.`,
    {
      status: context.status,
      requestMayHaveBeenApplied: context.requestMayHaveBeenApplied,
    },
  );
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `an array of ${value.length} item(s)`;
  }

  if (typeof value === "object") {
    return `an object with keys ${truncate(Object.keys(value).join(", "), 80)}`;
  }

  return `${typeof value} (${truncate(String(value), 80)})`;
}
