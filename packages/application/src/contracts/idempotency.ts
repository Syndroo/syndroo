/**
 * Canonical create-request comparison.
 *
 * The existing API rule is: identical `content` bytes, platform set compared
 * without order, per-platform `override.content`, and normalized `scheduledAt`.
 * Serializing the whole request object would make field order part of the
 * identity and turn a harmless reordering into a spurious 409, so the
 * canonical form below is a fixed-order tuple instead.
 */

import { PLATFORMS, type Platform } from "@syndroo/core";

import { InvalidContractInputError, isIsoInstant } from "./primitives.js";

export const CREATE_POST_SCOPE = "posts.create.v1";

/**
 * Existing public contract: the header is optional and, when present, must use
 * 1-128 letters, digits, dots, underscores, colons or hyphens.
 */
export const CREATE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isCreateIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && CREATE_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export interface CanonicalCreateRequest {
  readonly content: string;
  readonly platforms: readonly Platform[];
  readonly overrides?: Readonly<Partial<Record<Platform, { readonly content?: string }>>>;
  /** Already normalized at the decode boundary; offsets and missing ms are rejected. */
  readonly scheduledAt?: string | null;
}

const FINGERPRINT_VERSION = 1;

/**
 * Deterministic, order-insensitive encoding of the fields that define create
 * identity. Returned as text so an adapter may store or hash it.
 */
export function canonicalCreateRequestBytes(request: CanonicalCreateRequest): string {
  if (typeof request.content !== "string") {
    throw new InvalidContractInputError("create request content must be a string");
  }
  // Sorted copy with duplicates preserved: the existing rule compares platform
  // set length as well as membership, so ["x","x"] must not equal ["x"].
  const platforms = [...request.platforms].sort();
  const scheduledAt = request.scheduledAt ?? null;
  if (scheduledAt !== null && !isIsoInstant(scheduledAt)) {
    throw new InvalidContractInputError(
      "create request scheduledAt must be a canonical UTC instant before comparison",
    );
  }
  // Mirrors `samePostRequest`: overrides are compared across the fixed platform
  // list, so an override on a non-selected platform still affects identity.
  const overrides = PLATFORMS.map((platform) => {
    const content = request.overrides?.[platform]?.content;
    return [platform, content ?? null] as const;
  });
  return JSON.stringify([
    FINGERPRINT_VERSION,
    request.content,
    platforms,
    overrides,
    scheduledAt,
  ]);
}

/**
 * SHA-256 fingerprint of the canonical bytes.
 *
 * Uses the standard WebCrypto digest; no Node crypto import is involved. The
 * store treats the result as an opaque equality token.
 */
export async function canonicalCreateRequestFingerprint(
  request: CanonicalCreateRequest,
): Promise<string> {
  return sha256Hex(canonicalCreateRequestBytes(request));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  // Copy into a plain ArrayBuffer so the digest input is an unambiguous
  // BufferSource regardless of the typed-array buffer variance in newer libs.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
