/**
 * Shared primitives for the portable 0.5.0 publishing use cases.
 *
 * Runtime-neutral on purpose: no Cloudflare, Node, provider or HTTP types
 * appear here. Use-case failures travel as `PublishingUseCaseError` carrying
 * one fixed code plus one fixed reason enum, so a runtime can map a status
 * without ever echoing provider, transport or storage detail. Messages come
 * from a closed allowlist and never interpolate caller or provider values.
 */

import { isPlatform, type CreatePostInput, type Platform } from "@syndroo/core";

import type { CreateConflictReason } from "../contracts/execution.js";
import { isCreateIdempotencyKey } from "../contracts/idempotency.js";
import {
  InvalidContractInputError,
  isIsoInstant,
  isOpaqueId,
  type IsoInstant,
} from "../contracts/primitives.js";
import type { PublisherBlockReason } from "../ports/publisher-strategy.js";

/** Existing public create limit; the HTTP decoder owns the wire message. */
export const MAX_CONTENT_CODE_POINTS = 10_000;

/** Dispatcher run budget for one wake; larger requested limits are capped here. */
export const MAX_DISPATCH_JOBS_PER_TICK = 20;

export type PublishingErrorCode =
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "PUBLISHER_PREPARATION_BLOCKED"
  | "INSTANCE_NOT_READY"
  | "CREATE_CONFLICT";

/**
 * Fixed reasons a use case may report. Every member is a closed enum owned by
 * this repository: a request-field label, a strategy block reason, or a create
 * conflict reason. No raw text is ever produced.
 */
export type PublishingErrorReason =
  | "request_body"
  | "content"
  | "platforms"
  | "overrides"
  | "scheduled_at"
  | "idempotency_key"
  | PublisherBlockReason
  | CreateConflictReason
  | "unavailable";

const CODE_MESSAGES: Readonly<Record<PublishingErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "request is not structurally valid",
  IDEMPOTENCY_CONFLICT: "idempotency key was already used with a different request",
  PUBLISHER_PREPARATION_BLOCKED: "publishing is not ready for a requested platform",
  INSTANCE_NOT_READY: "the publishing instance is not ready",
  CREATE_CONFLICT: "the create request conflicted with current credential state",
});

/**
 * A safe, map-ready use-case failure.
 *
 * `code` selects the public error family (`INVALID_REQUEST` -> 400,
 * `IDEMPOTENCY_CONFLICT` -> 409, `PUBLISHER_PREPARATION_BLOCKED` -> controlled
 * platform readiness error, `INSTANCE_NOT_READY` -> 503 instance
 * configuration/key failure, `CREATE_CONFLICT` -> conflict). `reason` is
 * optional and always one of the fixed enum values.
 */
export class PublishingUseCaseError extends Error {
  public readonly code: PublishingErrorCode;
  public readonly reason: PublishingErrorReason | null;

  public constructor(code: PublishingErrorCode, reason: PublishingErrorReason | null = null) {
    super(CODE_MESSAGES[code]);
    this.name = "PublishingUseCaseError";
    this.code = code;
    this.reason = reason;
  }
}

/** Injected wall clock returning canonical UTC instants. */
export interface UseCaseClock {
  now(): IsoInstant;
}

export type UseCaseIdKind = "post" | "publication" | "job";

/** Injected identity source; the application never generates IDs itself. */
export type UseCaseIdFactory = (kind: UseCaseIdKind) => string;

export function readClockNow(clock: UseCaseClock): IsoInstant {
  const value = clock.now();
  if (!isIsoInstant(value)) {
    // Wiring error, not caller input: a bad clock is a programming defect.
    throw new InvalidContractInputError("clock must return a canonical UTC instant");
  }
  return value;
}

export function createUseCaseId(ids: UseCaseIdFactory, kind: UseCaseIdKind): string {
  const value = ids(kind);
  if (!isOpaqueId(value)) {
    throw new InvalidContractInputError(
      "id factory must return a bounded opaque identifier",
    );
  }
  return value;
}

/** Immutable copy of the caller's create intent. */
export interface NormalizedCreateInput {
  readonly content: string;
  readonly platforms: readonly Platform[];
  readonly overrides: Readonly<Partial<Record<Platform, { readonly content?: string }>>>;
  readonly scheduledAt: IsoInstant | null;
}

function invalidRequest(reason: PublishingErrorReason): PublishingUseCaseError {
  return new PublishingUseCaseError("INVALID_REQUEST", reason);
}

function requireCreateContent(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest("content");
  }
  if ([...value].length > MAX_CONTENT_CODE_POINTS) {
    throw invalidRequest("content");
  }
  return value;
}

function requireCreatePlatforms(value: unknown): readonly Platform[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("platforms");
  }
  const platforms: Platform[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlatform(entry) || seen.has(entry)) {
      // Known-but-uninstalled platforms stay structurally valid: readiness is
      // decided by preparation, never by the request decoder.
      throw invalidRequest("platforms");
    }
    seen.add(entry);
    platforms.push(entry);
  }
  return Object.freeze(platforms);
}

function requireCreateOverrides(
  value: unknown,
  platforms: readonly Platform[],
): Readonly<Partial<Record<Platform, { readonly content?: string }>>> {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("overrides");
  }
  const snapshot: Partial<Record<Platform, { readonly content?: string }>> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isPlatform(key) || !platforms.includes(key)) {
      throw invalidRequest("overrides");
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalidRequest("overrides");
    }
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 1 || entryKeys[0] !== "content") {
      throw invalidRequest("overrides");
    }
    snapshot[key] = Object.freeze({
      content: requireCreateContent((entry as Record<string, unknown>)["content"]),
    });
  }
  return Object.freeze(snapshot);
}

function requireCreateScheduledAt(value: unknown): IsoInstant | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isIsoInstant(value)) {
    // Callers hand over an already normalized instant; offsets and missing
    // milliseconds are decoder concerns and are rejected here.
    throw invalidRequest("scheduled_at");
  }
  return value;
}

/**
 * Snapshot and structurally validate the caller's create intent.
 *
 * Must run before the first `await` of a create call: the returned value is an
 * independent copy, so a caller that mutates its own object while the use case
 * is suspended cannot change the computed fingerprint or the committed
 * content. Readiness, credentials and configuration are deliberately not
 * examined here; an idempotent replay is answered before any of that.
 */
export function snapshotCreateInput(input: CreatePostInput): NormalizedCreateInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest("request_body");
  }
  const content = requireCreateContent(input.content);
  const platforms = requireCreatePlatforms(input.platforms);
  const overrides = requireCreateOverrides(input.overrides, platforms);
  const scheduledAt = requireCreateScheduledAt(input.scheduledAt);
  return Object.freeze({ content, platforms, overrides, scheduledAt });
}

/**
 * Validate the optional original `Idempotency-Key` before any database read.
 * The alphabet is the existing public one; absence means "no idempotency".
 */
export function snapshotIdempotencyKey(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isCreateIdempotencyKey(value)) {
    throw invalidRequest("idempotency_key");
  }
  return value;
}
