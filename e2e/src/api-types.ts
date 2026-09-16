/**
 * Narrow readers for the documented Syndroo HTTP contract. They fail loudly
 * when the Worker returns an unexpected shape instead of letting a typo turn
 * into a passing assertion.
 */

export interface PostSummary {
  id: string;
  content: string;
  platforms: string[];
  status: string;
  createdAt: string;
  scheduledAt?: string;
}

export interface PublicationSummary {
  id: string;
  postId: string;
  platform: string;
  provider: string;
  content: string;
  status: string;
  attempts: number;
  externalId?: string;
  externalUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  errorAmbiguous?: boolean;
}

export interface PostDetail extends PostSummary {
  publications: PublicationSummary[];
}

export interface CreatePostResponse {
  id: string;
  status: string;
  scheduledAt?: string;
  enqueueDeferred?: boolean;
  replayed?: boolean;
}

export function parsePostDetail(value: unknown): PostDetail {
  const record = requireRecord(value, "post");
  const publications = requireArray(record.publications, "post.publications").map(
    (item, index) => parsePublication(item, `post.publications[${index}]`),
  );

  return { ...parsePostSummary(record, "post"), publications };
}

export function parsePostSummary(value: unknown, label = "post"): PostSummary {
  const record = requireRecord(value, label);
  const summary: PostSummary = {
    id: requireString(record.id, `${label}.id`),
    content: requireString(record.content, `${label}.content`),
    platforms: requireArray(record.platforms, `${label}.platforms`).map(
      (platform, index) =>
        requireString(platform, `${label}.platforms[${index}]`),
    ),
    status: requireString(record.status, `${label}.status`),
    createdAt: requireString(record.createdAt, `${label}.createdAt`),
  };
  const scheduledAt = optionalString(record.scheduledAt, `${label}.scheduledAt`);

  if (scheduledAt !== undefined) {
    summary.scheduledAt = scheduledAt;
  }

  return summary;
}

export function parseCreatePostResponse(value: unknown): CreatePostResponse {
  const record = requireRecord(value, "createPost");
  const result: CreatePostResponse = {
    id: requireString(record.id, "createPost.id"),
    status: requireString(record.status, "createPost.status"),
  };
  const scheduledAt = optionalString(record.scheduledAt, "createPost.scheduledAt");
  const replayed = optionalBoolean(record.replayed, "createPost.replayed");
  const enqueueDeferred = optionalBoolean(
    record.enqueueDeferred,
    "createPost.enqueueDeferred",
  );

  if (scheduledAt !== undefined) {
    result.scheduledAt = scheduledAt;
  }

  if (replayed !== undefined) {
    result.replayed = replayed;
  }

  if (enqueueDeferred !== undefined) {
    result.enqueueDeferred = enqueueDeferred;
  }

  return result;
}

export function parsePostList(value: unknown): PostSummary[] {
  const record = requireRecord(value, "postList");
  return requireArray(record.items, "postList.items").map((item, index) =>
    parsePostSummary(item, `postList.items[${index}]`),
  );
}

/** The single publication for a platform, or a descriptive failure. */
export function publicationFor(
  post: PostDetail,
  platform: string,
): PublicationSummary {
  const matches = post.publications.filter(
    publication => publication.platform === platform,
  );

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${platform} publication on post ${post.id}, found ${matches.length}. ` +
        `Platforms: ${post.publications.map(publication => publication.platform).join(", ")}`,
    );
  }

  const [match] = matches;

  if (!match) {
    throw new Error(`Expected exactly one ${platform} publication on post ${post.id}`);
  }

  return match;
}

function parsePublication(value: unknown, label: string): PublicationSummary {
  const record = requireRecord(value, label);
  const publication: PublicationSummary = {
    id: requireString(record.id, `${label}.id`),
    postId: requireString(record.postId, `${label}.postId`),
    platform: requireString(record.platform, `${label}.platform`),
    provider: requireString(record.provider, `${label}.provider`),
    content: requireString(record.content, `${label}.content`),
    status: requireString(record.status, `${label}.status`),
    attempts: requireNumber(record.attempts, `${label}.attempts`),
  };
  const externalId = optionalString(record.externalId, `${label}.externalId`);
  const externalUrl = optionalString(record.externalUrl, `${label}.externalUrl`);
  const errorCode = optionalString(record.errorCode, `${label}.errorCode`);
  const errorMessage = optionalString(record.errorMessage, `${label}.errorMessage`);
  const errorAmbiguous = optionalBoolean(
    record.errorAmbiguous,
    `${label}.errorAmbiguous`,
  );

  if (externalId !== undefined) {
    publication.externalId = externalId;
  }

  if (externalUrl !== undefined) {
    publication.externalUrl = externalUrl;
  }

  if (errorCode !== undefined) {
    publication.errorCode = errorCode;
  }

  if (errorMessage !== undefined) {
    publication.errorMessage = errorMessage;
  }

  if (errorAmbiguous !== undefined) {
    publication.errorAmbiguous = errorAmbiguous;
  }

  return publication;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object, received ${describe(value)}`);
  }

  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array, received ${describe(value)}`);
  }

  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string, received ${describe(value)}`);
  }

  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${label} to be a number, received ${describe(value)}`);
  }

  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected ${label} to be a boolean, received ${describe(value)}`);
  }

  return value;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }

  return typeof value === "object" ? "an object" : `${typeof value} (${String(value)})`;
}
