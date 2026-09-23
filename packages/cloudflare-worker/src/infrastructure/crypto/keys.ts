/**
 * Shared key material validation for the 0.5.0 credential adapters.
 *
 * Both keys are explicit, encoded, independently provisioned secrets. Nothing
 * here derives a key from another key, from an API key, or from any default.
 */
import { CipherUnavailableError } from "@syndroo/application";
import { isPlatform } from "@syndroo/core";

import {
  InvalidContractInputError,
  isOpaqueId,
  type CipherContext,
} from "@syndroo/application";

/** Canonical padded base64 of exactly 32 bytes. */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;
/** Non-secret key identifier: bounded, fixed safe charset. */
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

export const AES_256_KEY_BYTES = 32;
export const AES_GCM_IV_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const MAX_CREDENTIAL_PAYLOAD_BYTES = 64 * 1024;

/** Maximum base64 length that can represent a value of `byteLength`. */
export function maxBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4 + 4;
}

const CIPHER_PURPOSES: readonly string[] = [
  "active_slot",
  "oauth_request_secret",
  "oauth_candidate",
  "pkce_verifier",
];

/**
 * Validates the trusted AAD context before any encoding.
 *
 * The context is supplied by the caller's own record identity, never by the
 * ciphertext, so an unknown purpose, platform or a malformed identifier fails
 * closed instead of producing a different (but valid-looking) binding.
 */
export function requireCipherContext(context: CipherContext): CipherContext {
  if (context === null || typeof context !== "object") {
    throw new InvalidContractInputError("cipher context must be an object");
  }

  if (!CIPHER_PURPOSES.includes(context.purpose)) {
    throw new InvalidContractInputError("cipher context purpose is not supported");
  }

  if (!isPlatform(context.platform)) {
    throw new InvalidContractInputError("cipher context platform is not supported");
  }

  if (!isOpaqueId(context.recordId)) {
    throw new InvalidContractInputError("cipher context record id must be a bounded identifier");
  }

  for (const value of [context.payloadSchemaVersion, context.payloadRevision]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new InvalidContractInputError("cipher context versions must be positive integers");
    }
  }

  return context;
}

/**
 * Decodes a base64 secret into exactly 32 bytes.
 *
 * The error text is fixed: a malformed key is never echoed back, and a key with
 * the wrong length is a configuration failure rather than a retryable condition.
 */
export function decodeAes256Key(encoded: unknown): Uint8Array {
  if (typeof encoded !== "string" || !BASE64_32_BYTES.test(encoded)) {
    throw new CipherUnavailableError("cipher key must be canonical padded base64 of 32 bytes");
  }

  const bytes = decodeBase64(encoded);

  if (bytes === null || bytes.byteLength !== AES_256_KEY_BYTES) {
    throw new CipherUnavailableError("cipher key must be canonical padded base64 of 32 bytes");
  }

  return bytes;
}

/** Binding keys must be at least 32 bytes and are never the API key. */
export function decodeBindingKey(encoded: unknown): Uint8Array {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("binding key must be an encoded secret of at least 32 bytes");
  }

  const bytes = decodeBase64(encoded);

  if (bytes === null || bytes.byteLength < AES_256_KEY_BYTES) {
    throw new Error("binding key must be an encoded secret of at least 32 bytes");
  }

  return bytes;
}

export function requireKeyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw new CipherUnavailableError("credential key id must be a bounded safe identifier");
  }

  return value;
}

/**
 * Strict base64 decoding: canonical padded form only, no URL-safe alphabet, no
 * whitespace, no missing padding. Returns null instead of throwing so callers
 * can attach a fixed, context-appropriate message.
 */
export function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) {
    return null;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }

  let binary: string;

  try {
    binary = atob(value);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  // Reject non-canonical encodings that decode to the same bytes.
  return encodeBase64(bytes) === value ? bytes : null;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
