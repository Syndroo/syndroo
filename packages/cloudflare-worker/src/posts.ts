import {
  PLATFORMS,
  isPlatform,
  type CreatePostInput,
  type Platform,
  type Post,
  type Publication,
  type PublicationJob,
} from "@syndroo/core";

import { ApiError } from "./http.js";
import { D1Repository } from "./repository.js";
import { isPlatformConfigured, providerFor } from "./publishers.js";

const MAX_CONTENT_CODE_POINTS = 10_000;

export interface CreatePostResult {
  id: string;
  status: Post["status"];
  scheduledAt?: string;
  enqueueDeferred?: boolean;
  replayed?: boolean;
}

export function parseCreatePost(value: unknown, env: Env): CreatePostInput {
  if (!isRecord(value)) {
    throw invalid("Request body must be an object");
  }

  const content = parseContent(value.content, "content");
  const platforms = parsePlatforms(value.platforms, env);
  const overrides = parseOverrides(value.overrides, platforms);
  const scheduledAt = parseScheduledAt(value.scheduledAt);
  const input: CreatePostInput = { content, platforms };

  if (overrides) {
    input.overrides = overrides;
  }

  if (scheduledAt) {
    input.scheduledAt = scheduledAt;
  }

  return input;
}

export async function createPost(
  input: CreatePostInput,
  repository: D1Repository,
  queue: Queue<PublicationJob>,
  now: Date,
  idempotencyKey?: string,
): Promise<CreatePostResult> {
  if (idempotencyKey) {
    const existing = await repository.getPostByIdempotencyKey(idempotencyKey);

    if (existing) {
      return replayResult(existing, input);
    }
  }

  const nowIso = now.toISOString();
  const scheduled =
    input.scheduledAt !== undefined &&
    new Date(input.scheduledAt).getTime() > now.getTime();
  const post: Post = {
    id: createId("post"),
    content: input.content,
    platforms: input.platforms,
    status: scheduled ? "scheduled" : "queued",
    createdAt: nowIso,
  };

  if (input.overrides) {
    post.overrides = input.overrides;
  }

  if (input.scheduledAt) {
    post.scheduledAt = input.scheduledAt;
  }

  const publications = input.platforms.map<Publication>(platform => ({
    id: createId("pub"),
    postId: post.id,
    platform,
    provider: providerFor(platform),
    content: input.overrides?.[platform]?.content ?? input.content,
    status: scheduled ? "scheduled" : "pending",
    attempts: 0,
    errorAmbiguous: false,
    createdAt: nowIso,
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
  }));

  try {
    await repository.createPost(post, publications, idempotencyKey);
  } catch (error) {
    if (idempotencyKey) {
      const existing = await repository.getPostByIdempotencyKey(idempotencyKey);

      if (existing) {
        return replayResult(existing, input);
      }
    }

    throw error;
  }

  if (scheduled && input.scheduledAt !== undefined) {
    return {
      id: post.id,
      status: "scheduled",
      scheduledAt: input.scheduledAt,
    };
  }

  let enqueueDeferred = false;

  try {
    await queue.sendBatch(
      publications.map(publication => ({
        body: { publicationId: publication.id },
        contentType: "json",
      })),
    );
    await repository.markEnqueued(
      publications.map(publication => publication.id),
      nowIso,
    );
  } catch (error) {
    enqueueDeferred = true;
    console.error(
      JSON.stringify({
        event: "post_enqueue_deferred",
        postId: post.id,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }

  return {
    id: post.id,
    status: "queued",
    ...(enqueueDeferred ? { enqueueDeferred: true } : {}),
  };
}

function parseContent(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(field + " must be a non-empty string");
  }

  if ([...value].length > MAX_CONTENT_CODE_POINTS) {
    throw invalid(field + " exceeds " + MAX_CONTENT_CODE_POINTS + " characters");
  }

  return value;
}

function parsePlatforms(value: unknown, env: Env): Platform[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid("platforms must be a non-empty array");
  }

  if (value.length > PLATFORMS.length) {
    throw invalid("platforms contains too many entries");
  }

  const platforms: Platform[] = [];
  const seen = new Set<Platform>();

  for (const item of value) {
    if (!isPlatform(item)) {
      throw invalid("platforms contains an unsupported platform");
    }

    if (!isPlatformConfigured(item, env)) {
      throw new ApiError(
        "Platform is not configured yet: " + item,
        422,
        "PLATFORM_NOT_CONFIGURED",
      );
    }

    if (seen.has(item)) {
      throw invalid("platforms must not contain duplicates");
    }

    seen.add(item);
    platforms.push(item);
  }

  return platforms;
}

function parseOverrides(
  value: unknown,
  platforms: Platform[],
): Partial<Record<Platform, { content?: string }>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw invalid("overrides must be an object");
  }

  const overrides: Partial<Record<Platform, { content?: string }>> = {};

  for (const [key, override] of Object.entries(value)) {
    if (!isPlatform(key) || !platforms.includes(key)) {
      throw invalid("overrides contains a platform not selected in platforms");
    }

    if (!isRecord(override)) {
      throw invalid("override for " + key + " must be an object");
    }

    const unknownKeys = Object.keys(override).filter(item => item !== "content");

    if (unknownKeys.length > 0) {
      throw invalid("override for " + key + " contains unsupported fields");
    }

    overrides[key] = {
      content: parseContent(override.content, "overrides." + key + ".content"),
    };
  }

  return overrides;
}

function parseScheduledAt(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw invalid("scheduledAt must be an ISO date-time string");
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw invalid("scheduledAt must be a valid ISO date-time string");
  }

  return new Date(timestamp).toISOString();
}

function replayResult(post: Post, input: CreatePostInput): CreatePostResult {
  if (!samePostRequest(post, input)) {
    throw new ApiError(
      "Idempotency-Key was already used with a different request",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }

  return {
    id: post.id,
    status: post.status,
    ...(post.scheduledAt ? { scheduledAt: post.scheduledAt } : {}),
    replayed: true,
  };
}

function samePostRequest(post: Post, input: CreatePostInput): boolean {
  return (
    post.content === input.content &&
    post.platforms.length === input.platforms.length &&
    post.platforms.every(platform => input.platforms.includes(platform)) &&
    PLATFORMS.every(
      platform =>
        post.overrides?.[platform]?.content ===
        input.overrides?.[platform]?.content,
    ) &&
    post.scheduledAt === input.scheduledAt
  );
}

function createId(prefix: "post" | "pub"): string {
  return prefix + "_" + crypto.randomUUID();
}

function invalid(message: string): ApiError {
  return new ApiError(message, 400, "INVALID_REQUEST");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
