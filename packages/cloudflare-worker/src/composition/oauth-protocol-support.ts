/**
 * Small protocol helpers shared by the concrete OAuth drivers.
 *
 * Everything here is pure: string parsing, canonical payload encoding and the
 * strict numeric rules around `expires_in`. No request, no storage, no Env
 * binding and no provider-specific policy lives in this module.
 */

import { isIsoInstant, type IsoInstant } from "@syndroo/application";
import type { Platform } from "@syndroo/core";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_ORIGIN_LENGTH = 2_048;
export const MAX_NATIVE_PAYLOAD_BYTES = 64 * 1024;

/**
 * Parse `SYNDROO_PUBLIC_URL` as an HTTPS origin.
 *
 * Only a bare origin is accepted: no userinfo, no non-root path, no query, no
 * fragment and no control characters or surrounding whitespace. Values are
 * rejected rather than silently stripped.
 */
export function parsePublicOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  if (CONTROL_CHARACTER.test(value) || value !== value.trim()) {
    return null;
  }
  // Validate the raw form *before* `URL` normalization can hide a path, query
  // or fragment: only `https://host` and `https://host/` are accepted, with no
  // backslash, no path segment, no `?` and no `#` in the input at all.
  if (!/^https:\/\/[^\s/?#\\]+(\/)?$/.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    return null;
  }
  return url.origin;
}

/** The exact known callback path for one platform. */
export function canonicalCallbackUrl(origin: string, platform: Platform): string {
  return `${origin}/v1/auth/${platform}/callback`;
}

/**
 * Validate one fixed provider endpoint.
 *
 * Fixed endpoints may carry a path, but never userinfo, a query, a fragment or
 * control characters, and they must be HTTPS.
 */
export function requireFixedHttpsEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  if (CONTROL_CHARACTER.test(value) || value !== value.trim()) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    return null;
  }
  return url.toString();
}

/**
 * Strict `application/x-www-form-urlencoded` response parser.
 *
 * A duplicate required field, a segment without `=`, an undecodable segment or
 * a missing or empty required field rejects the whole response. Unknown fields
 * are ignored, which is how OAuth1 providers add optional metadata.
 */
export function parseFormResponse(
  text: string,
  required: readonly string[],
): Readonly<Record<string, string>> | null {
  if (text.length === 0) {
    return null;
  }
  const seen = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const segment of text.split("&")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) {
      return null;
    }
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(segment.slice(0, separator).replace(/\+/g, " "));
      value = decodeURIComponent(segment.slice(separator + 1).replace(/\+/g, " "));
    } catch {
      return null;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (!seen.has(name)) {
      seen.set(name, value);
    }
  }
  const result: Record<string, string> = {};
  for (const name of required) {
    const count = counts.get(name) ?? 0;
    const value = seen.get(name);
    if (count !== 1 || value === undefined || value === "") {
      return null;
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

/** Strict JSON object response: an array, primitive or null payload fails. */
export function parseJsonObjectResponse(text: string): Readonly<Record<string, unknown>> | null {
  if (text.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export type ExpiryResult =
  | { readonly kind: "ok"; readonly expiresAt: IsoInstant | null }
  | { readonly kind: "invalid" };

/**
 * `expires_in` rules against an explicit exchange-time baseline.
 *
 * An absent field means unknown (null). Zero means immediate expiry at the
 * baseline. Negative, non-finite, fractional, wrong-type and overflowing values
 * are invalid rather than clamped.
 */
export function expiresAtFromSeconds(value: unknown, baseline: IsoInstant): ExpiryResult {
  if (value === undefined) {
    return { kind: "ok", expiresAt: null };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { kind: "invalid" };
  }
  if (!Number.isSafeInteger(value)) {
    return { kind: "invalid" };
  }
  const baselineMs = Date.parse(baseline);
  const expiresMs = baselineMs + value * 1_000;
  // `Number.isSafeInteger` alone is not enough: the Date domain ends at
  // +/-8.64e15 ms, and `toISOString` would throw beyond it.
  if (!Number.isSafeInteger(expiresMs) || Math.abs(expiresMs) > MAX_DATE_MS) {
    return { kind: "invalid" };
  }
  try {
    const expiresAt = new Date(expiresMs).toISOString();
    return isIsoInstant(expiresAt) ? { kind: "ok", expiresAt } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/** Canonical JSON for one native credential record, with sorted keys. */
export function encodeNativePayload(fields: Readonly<Record<string, string>>): Uint8Array {
  const ordered: Record<string, string> = {};
  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    if (value !== undefined) {
      ordered[name] = value;
    }
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * The one rule for an opaque credential value.
 *
 * Native payload parsing, provider-output validation and OAuth1 token
 * acquisition all share this predicate, so any value a driver returns as a
 * credential can be read back by the candidate/active native parser. Values are
 * never trimmed: a padded value is rejected instead of silently becoming a
 * different token.
 */
export function isOpaqueCredentialValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !CONTROL_CHARACTER.test(value) &&
    value === value.trim()
  );
}

/**
 * Strict native payload reader.
 *
 * The stored plaintext is a flat object of bounded strings; anything else fails
 * so a hostile record can never reach confirmation or refresh logic.
 */
export function parseNativePayload(bytes: Uint8Array): ReadonlyMap<string, string> | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return null;
  }
  if (bytes.byteLength > MAX_NATIVE_PAYLOAD_BYTES) {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const record = parseJsonObjectResponse(text);
  if (record === null) {
    return null;
  }
  // A `Map` accumulator: an own `__proto__` (or any other dangerous name) can
  // never pollute the result or silently vanish here; unknown names are rejected
  // by the platform boundary instead.
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries(record)) {
    if (!isOpaqueCredentialValue(value)) {
      return null;
    }
    fields.set(name, value);
  }
  return fields;
}

/** ECMAScript Date domain bound in milliseconds. */
const MAX_DATE_MS = 8.64e15;
