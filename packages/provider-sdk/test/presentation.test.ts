import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_LIMITS,
  PRESENTATION_LIMITS,
  isSafeDisplayText,
  safePublicUrl,
  sanitizeAccountName,
  sanitizeAccountPresentation,
  DIAGNOSTIC_MESSAGES,
  sanitizeDiagnosticMessage,
  sanitizeSafeDiagnostic,
  sanitizeTargetPresentation,
} from "../src/index.js";

const PROFILE_URL = "https://social.example/@syndroo";

describe("optional account presentation", () => {
  it("keeps only the fields it can prove safe and drops every unknown key", () => {
    expect(
      sanitizeAccountPresentation({
        accountName: "syndroo",
        profileUrl: PROFILE_URL,
        injection: "https://evil.example",
        toString: "x",
      }),
    ).toEqual({ accountName: "syndroo", profileUrl: PROFILE_URL });

    expect(sanitizeTargetPresentation({ label: "Engineering", accountName: "syndroo", extra: 1 })).toEqual(
      { accountName: "syndroo", label: "Engineering" },
    );
  });

  it("drops one invalid field without losing the other", () => {
    expect(sanitizeAccountPresentation({ accountName: "\u001b[31mred", profileUrl: PROFILE_URL })).toEqual({
      profileUrl: PROFILE_URL,
    });
    expect(sanitizeAccountPresentation({ accountName: "syndroo", profileUrl: "http://social.example/@s" })).toEqual({
      accountName: "syndroo",
    });
  });

  it("returns undefined when nothing survives, for non-records and for empty records", () => {
    expect(sanitizeAccountPresentation(undefined)).toBeUndefined();
    expect(sanitizeAccountPresentation(null)).toBeUndefined();
    expect(sanitizeAccountPresentation("syndroo")).toBeUndefined();
    expect(sanitizeAccountPresentation(["syndroo"])).toBeUndefined();
    expect(sanitizeAccountPresentation({ accountName: 42, profileUrl: 42 })).toBeUndefined();
    expect(sanitizeAccountPresentation({})).toBeUndefined();
    expect(sanitizeTargetPresentation(new Date())).toBeUndefined();
  });

  it("enforces the 1-256 code point account name bound", () => {
    expect(sanitizeAccountName("a".repeat(PRESENTATION_LIMITS.nameMax))).toHaveLength(256);
    expect(sanitizeAccountName("a".repeat(PRESENTATION_LIMITS.nameMax + 1))).toBeUndefined();
    expect(sanitizeAccountName("")).toBeUndefined();

    // Code points, not UTF-16 units: an astral emoji counts once.
    const emoji = "🙂".repeat(PRESENTATION_LIMITS.nameMax);
    expect([...emoji]).toHaveLength(256);
    expect(sanitizeAccountName(emoji)).toBe(emoji);
    expect(sanitizeAccountName("🙂".repeat(PRESENTATION_LIMITS.nameMax + 1))).toBeUndefined();
  });

  it("rejects unsafe display text rather than repairing it", () => {
    for (const value of [
      "line\nbreak",
      "carriage\rreturn",
      "esc\u001b[2J",
      "csi\u009b",
      "nul\u0000",
      "bidi\u202elabel",
      "zwsp\u200bname",
      "lone\ud800surrogate",
    ]) {
      expect(isSafeDisplayText(value)).toBe(false);
      expect(sanitizeAccountName(value)).toBeUndefined();
    }
    expect(isSafeDisplayText("日本語 🙂 café")).toBe(true);
  });
});

describe("conservative public URL", () => {
  it("accepts only https URLs without userinfo, query or fragment", () => {
    expect(safePublicUrl(PROFILE_URL)).toBe(PROFILE_URL);
    expect(safePublicUrl("https://social.example")).toBe("https://social.example");
    expect(safePublicUrl("https://social.example/@a?x=1")).toBeUndefined();
    expect(safePublicUrl("https://social.example/@a#bio")).toBeUndefined();
    expect(safePublicUrl("https://user:pass@social.example/@a")).toBeUndefined();
    expect(safePublicUrl("https://user@social.example/@a")).toBeUndefined();
    expect(safePublicUrl("http://social.example/@a")).toBeUndefined();
    expect(safePublicUrl("HTTPS://SOCIAL.EXAMPLE/@a".replace("HTTPS", "https"))).toBe(
      "https://SOCIAL.EXAMPLE/@a",
    );
  });

  it("rejects control characters, bidi overrides and non-strings", () => {
    for (const value of [
      "https://social.example\u001b[2J",
      "https://social.example\u202e/@a",
      "https://social.example\n/@a",
      "https://social.example\u0000",
      "https://social.example\u009b",
      "https://social.example/a\u061cb",
      "https://social.example/a\u200bb",
      `https://social.example/${"a".repeat(3000)}`,
      "",
    ]) {
      expect(safePublicUrl(value)).toBeUndefined();
    }
    expect(safePublicUrl(undefined)).toBeUndefined();
    expect(safePublicUrl(1234)).toBeUndefined();
  });

  it("enforces the 2048 character URL bound at the boundary", () => {
    const pad = (n: number) => `https://social.example/${"a".repeat(n - "https://social.example/".length)}`;
    const atLimit = pad(PRESENTATION_LIMITS.urlMax);
    expect(atLimit).toHaveLength(PRESENTATION_LIMITS.urlMax);
    expect(safePublicUrl(atLimit)).toBe(atLimit);
    expect(safePublicUrl(pad(PRESENTATION_LIMITS.urlMax + 1))).toBeUndefined();
  });

  it("does not trust a string merely because it starts with https://", () => {
    expect(safePublicUrl("https://")).toBeUndefined();
    expect(safePublicUrl("https:///nohost")).toBeUndefined();
  });
});

describe("safe diagnostics", () => {
  it("keeps only a bounded provider code, integer status and reviewed message", () => {
    expect(
      sanitizeSafeDiagnostic({
        providerCode: "rate.limited",
        httpStatus: 429,
        message: DIAGNOSTIC_MESSAGES.rate_limited,
        extra: true,
      }),
    ).toEqual({
      providerCode: "rate.limited",
      httpStatus: 429,
      message: DIAGNOSTIC_MESSAGES.rate_limited,
    });
  });

  it("enforces the provider code grammar", () => {
    expect(sanitizeSafeDiagnostic({ providerCode: "a".repeat(DIAGNOSTIC_LIMITS.codeMax) })).toBeDefined();
    expect(sanitizeSafeDiagnostic({ providerCode: "a".repeat(DIAGNOSTIC_LIMITS.codeMax + 1) })).toBeUndefined();
    for (const code of ["", "has space", "semi;colon", "slash/code", "emoji🙂"])
      expect(sanitizeSafeDiagnostic({ providerCode: code })).toBeUndefined();
  });

  it("enforces the 100-599 integer status bound", () => {
    expect(sanitizeSafeDiagnostic({ httpStatus: 100 })).toEqual({ httpStatus: 100 });
    expect(sanitizeSafeDiagnostic({ httpStatus: 599 })).toEqual({ httpStatus: 599 });
    for (const status of [99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, "429", null])
      expect(sanitizeSafeDiagnostic({ httpStatus: status })).toBeUndefined();
  });

  it("accepts only the fixed, reviewed message templates", () => {
    for (const message of Object.values(DIAGNOSTIC_MESSAGES)) {
      expect(sanitizeDiagnosticMessage(message)).toBe(message);
      expect(sanitizeSafeDiagnostic({ message })).toEqual({ message });
    }
  });

  it("never accepts a single-line secret, cookie or raw body as a message", () => {
    // Length and character validation is not a redaction boundary: a short,
    // control-free credential must still be rejected.
    for (const message of [
      "Authorization: Bearer FAKE_SECRET_FOR_REVIEW",
      "Cookie: session=FAKE_SECRET_FOR_REVIEW",
      "sk_live_FAKE_canary_value_for_diagnostics",
      "Sending 500 to https://api.example/v1/posts",
      "stack\nat Object.<anonymous>",
      "raw\u001b[31mprovider body",
      "x".repeat(DIAGNOSTIC_LIMITS.messageMax),
      "",
    ]) {
      expect(sanitizeDiagnosticMessage(message)).toBeUndefined();
      expect(sanitizeSafeDiagnostic({ message })).toBeUndefined();
    }
  });

  it("returns undefined rather than an empty diagnostic object", () => {
    expect(sanitizeSafeDiagnostic(undefined)).toBeUndefined();
    expect(sanitizeSafeDiagnostic({})).toBeUndefined();
    expect(sanitizeSafeDiagnostic({ unknown: "value" })).toBeUndefined();
    expect(sanitizeSafeDiagnostic("plain string")).toBeUndefined();
  });
});
