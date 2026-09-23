/**
 * Bounded, versioned OAuth candidate codec.
 *
 * The credential store's candidate columns intentionally carry no separate
 * expiry column, so the native credential plaintext and its nullable expiry have
 * to travel inside the `oauth_candidate` ciphertext. The envelope is the smallest
 * thing that can hold both:
 *
 * ```
 * {"v":1,"p":"<base64 native plaintext>","e":"<canonical instant>"|null}
 * ```
 *
 * Both directions are total, non-throwing and strict: unknown keys, an
 * unsupported version, non-canonical base64, an invalid or non-canonical date
 * and anything above the cipher's 64 KiB plaintext bound are rejected with a
 * fixed reason instead of being truncated or repaired. Base64 inflates the
 * payload, so the bound applies to the encoded envelope: roughly 48 KiB of
 * native plaintext fits, and a larger candidate is reported as `oversize`.
 */

import { isIsoInstant, type IsoInstant } from "../contracts/primitives.js";

export const OAUTH_CANDIDATE_VERSION = 1;

/** Cipher bound on the encrypted plaintext, including the JSON envelope. */
export const MAX_OAUTH_CANDIDATE_BYTES = 64 * 1024;

export type OAuthCandidateFailureReason =
  | "unsupported_version"
  | "invalid_json"
  | "invalid_shape"
  | "invalid_date"
  | "oversize";

export interface OAuthCandidatePayload {
  readonly plaintext: Uint8Array;
  readonly expiresAt: IsoInstant | null;
}

export type OAuthCandidateEncodeResult =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "invalid"; readonly reason: OAuthCandidateFailureReason };

export type OAuthCandidateDecodeResult =
  | { readonly kind: "ok"; readonly payload: OAuthCandidatePayload }
  | { readonly kind: "invalid"; readonly reason: OAuthCandidateFailureReason };

const ENVELOPE_KEYS: readonly string[] = Object.freeze(["v", "p", "e"]);

/**
 * Encode one candidate payload.
 *
 * The plaintext bytes are copied into the envelope and never retained: the
 * caller may mutate its own buffer afterwards. The function is total: a hostile
 * object with a throwing getter is reported as `invalid_shape`, never rethrown.
 */
export function encodeOAuthCandidate(payload: OAuthCandidatePayload): OAuthCandidateEncodeResult {
  try {
    return encodeCandidateUnsafe(payload);
  } catch {
    return { kind: "invalid", reason: "invalid_shape" };
  }
}

function encodeCandidateUnsafe(payload: OAuthCandidatePayload): OAuthCandidateEncodeResult {
  let plaintext: Uint8Array;
  let expiresAt: IsoInstant | null;
  try {
    plaintext = payload.plaintext;
    expiresAt = payload.expiresAt;
  } catch {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  if (expiresAt !== null && !isIsoInstant(expiresAt)) {
    return { kind: "invalid", reason: "invalid_date" };
  }

  const encoded = toBase64(plaintext);
  if (encoded === null) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const envelope = `{"v":${OAUTH_CANDIDATE_VERSION},"p":"${encoded}","e":${
    expiresAt === null ? "null" : `"${expiresAt}"`
  }}`;
  const bytes = new TextEncoder().encode(envelope);
  if (bytes.byteLength > MAX_OAUTH_CANDIDATE_BYTES) {
    return { kind: "invalid", reason: "oversize" };
  }
  return { kind: "ok", bytes };
}

/** Decode one candidate envelope. Never throws for any byte input. */
export function decodeOAuthCandidate(bytes: Uint8Array): OAuthCandidateDecodeResult {
  try {
    return decodeCandidateUnsafe(bytes);
  } catch {
    return { kind: "invalid", reason: "invalid_shape" };
  }
}

function decodeCandidateUnsafe(bytes: Uint8Array): OAuthCandidateDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  if (bytes.byteLength > MAX_OAUTH_CANDIDATE_BYTES) {
    return { kind: "invalid", reason: "oversize" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      return { kind: "invalid", reason: "invalid_shape" };
    }
  }
  if (record["v"] !== OAUTH_CANDIDATE_VERSION) {
    return { kind: "invalid", reason: "unsupported_version" };
  }
  const encoded = record["p"];
  if (typeof encoded !== "string" || encoded.length === 0) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const expiresAt = record["e"];
  if (expiresAt !== null && !isIsoInstant(expiresAt)) {
    return { kind: "invalid", reason: "invalid_date" };
  }
  const plaintext = fromBase64(encoded);
  if (plaintext === null || plaintext.byteLength === 0) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  return { kind: "ok", payload: Object.freeze({ plaintext, expiresAt }) };
}

function toBase64(bytes: Uint8Array): string | null {
  try {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Strict base64 decode.
 *
 * A non-canonical encoding (wrong padding, URL-safe alphabet, embedded
 * whitespace or a re-encode mismatch) is rejected rather than normalized, so two
 * different envelopes cannot decode to the same stored plaintext.
 */
function fromBase64(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return null;
  }
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return toBase64(bytes) === encoded ? bytes : null;
  } catch {
    return null;
  }
}
