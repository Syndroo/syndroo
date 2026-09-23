/**
 * Task T6c1 — candidate codec tests.
 *
 * The codec is the only place a nullable expiry travels with the credential
 * plaintext, so strictness matters: an unsupported version, a non-canonical
 * base64 body, an invalid date or an oversized envelope must be rejected instead
 * of being normalized.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_OAUTH_CANDIDATE_BYTES,
  OAUTH_CANDIDATE_VERSION,
  decodeOAuthCandidate,
  encodeOAuthCandidate,
} from "../src/use-cases/oauth-candidate.js";
import { bodyBytes } from "./oauth-test-support.js";

function envelope(overrides: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: OAUTH_CANDIDATE_VERSION, p: "AAAA", e: null, ...overrides }),
  );
}

describe("oauth candidate codec", () => {
  it("round-trips plaintext and a nullable expiry", () => {
    const plaintext = bodyBytes({ token: "value" });
    const withExpiry = encodeOAuthCandidate({
      plaintext,
      expiresAt: "2026-12-31T23:59:59.000Z",
    });
    expect(withExpiry.kind).toBe("ok");
    if (withExpiry.kind !== "ok") {
      return;
    }
    const decoded = decodeOAuthCandidate(withExpiry.bytes);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") {
      return;
    }
    expect(Array.from(decoded.payload.plaintext)).toEqual(Array.from(plaintext));
    expect(decoded.payload.expiresAt).toBe("2026-12-31T23:59:59.000Z");

    const withoutExpiry = encodeOAuthCandidate({ plaintext, expiresAt: null });
    expect(withoutExpiry.kind).toBe("ok");
    if (withoutExpiry.kind === "ok") {
      const reopened = decodeOAuthCandidate(withoutExpiry.bytes);
      expect(reopened.kind === "ok" && reopened.payload.expiresAt).toBeNull();
    }
  });

  it("copies buffers in both directions", () => {
    const plaintext = bodyBytes({ token: "value" });
    const encoded = encodeOAuthCandidate({ plaintext, expiresAt: null });
    expect(encoded.kind).toBe("ok");
    if (encoded.kind !== "ok") {
      return;
    }
    const envelopeBytes = new Uint8Array(encoded.bytes);
    plaintext.fill(0);
    const decoded = decodeOAuthCandidate(envelopeBytes);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") {
      return;
    }
    expect(new TextDecoder().decode(decoded.payload.plaintext)).toBe('{"token":"value"}');

    decoded.payload.plaintext.fill(0);
    const again = decodeOAuthCandidate(envelopeBytes);
    expect(again.kind === "ok" && new TextDecoder().decode(again.payload.plaintext)).toBe(
      '{"token":"value"}',
    );
  });

  it("rejects unsupported versions and unknown keys", () => {
    expect(decodeOAuthCandidate(envelope({ v: 2 }))).toEqual({
      kind: "invalid",
      reason: "unsupported_version",
    });
    expect(decodeOAuthCandidate(envelope({ extra: true }))).toEqual({
      kind: "invalid",
      reason: "invalid_shape",
    });
  });

  it("rejects non-canonical base64 bodies", () => {
    for (const body of ["AA", "AAAA===", "AA+A/", "AAAA\n", "not base64!!"]) {
      const result = decodeOAuthCandidate(envelope({ p: body }));
      expect(result.kind, body).toBe("invalid");
    }
  });

  it("rejects invalid or non-canonical dates", () => {
    for (const date of ["2026-09-23T00:00:00Z", "not-a-date", 5, "2026-02-30T00:00:00.000Z"]) {
      expect(decodeOAuthCandidate(envelope({ e: date })), String(date)).toEqual({
        kind: "invalid",
        reason: "invalid_date",
      });
    }
  });

  it("rejects malformed JSON and shapes", () => {
    expect(decodeOAuthCandidate(new Uint8Array(0))).toEqual({
      kind: "invalid",
      reason: "invalid_shape",
    });
    expect(decodeOAuthCandidate(new TextEncoder().encode("not-json"))).toEqual({
      kind: "invalid",
      reason: "invalid_json",
    });
    expect(decodeOAuthCandidate(new TextEncoder().encode("[]"))).toEqual({
      kind: "invalid",
      reason: "invalid_shape",
    });
    expect(decodeOAuthCandidate(new TextEncoder().encode('{"v":1,"p":5,"e":null}'))).toEqual({
      kind: "invalid",
      reason: "invalid_shape",
    });
    // Invalid UTF-8 cannot be a JSON envelope.
    expect(decodeOAuthCandidate(new Uint8Array([0xff, 0xfe, 0xfd]))).toEqual({
      kind: "invalid",
      reason: "invalid_json",
    });
  });

  it("keeps the encrypted plaintext inside the cipher bound", () => {
    const fits = encodeOAuthCandidate({ plaintext: new Uint8Array(40 * 1024), expiresAt: null });
    expect(fits.kind).toBe("ok");
    if (fits.kind === "ok") {
      expect(fits.bytes.byteLength).toBeLessThanOrEqual(MAX_OAUTH_CANDIDATE_BYTES);
    }

    const oversized = encodeOAuthCandidate({
      plaintext: new Uint8Array(50 * 1024),
      expiresAt: null,
    });
    expect(oversized).toEqual({ kind: "invalid", reason: "oversize" });

    const storedOversize = encodeOAuthCandidate({
      plaintext: new Uint8Array(40 * 1024),
      expiresAt: null,
    });
    if (storedOversize.kind === "ok") {
      const padded = new Uint8Array(MAX_OAUTH_CANDIDATE_BYTES + 1);
      expect(decodeOAuthCandidate(padded).kind).toBe("invalid");
    }
  });

  it("rejects an empty or missing plaintext", () => {
    expect(encodeOAuthCandidate({ plaintext: new Uint8Array(0), expiresAt: null })).toEqual({
      kind: "invalid",
      reason: "invalid_shape",
    });
    expect(decodeOAuthCandidate(envelope({ p: "" }))).toEqual({
      kind: "invalid",
      reason: "invalid_shape",
    });
  });

  it("never throws for hostile input shapes", () => {
    const hostile = Object.create(Uint8Array.prototype);
    Object.defineProperty(hostile, "byteLength", {
      get() {
        throw new Error("SENTINEL_BYTE_LENGTH");
      },
    });
    let caught: unknown = null;
    try {
      decodeOAuthCandidate(hostile as Uint8Array);
    } catch (error) {
      caught = error;
    }
    expect(caught === null || !(caught instanceof Error) || !caught.message.includes("SENTINEL")).toBe(
      true,
    );
  });
});
