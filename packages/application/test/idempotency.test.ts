import { describe, expect, it } from "vitest";

import {
  InvalidContractInputError,
  canonicalCreateRequestBytes,
  canonicalCreateRequestFingerprint,
  isCreateIdempotencyKey,
} from "../src/index.js";

const base = {
  content: "hello world",
  platforms: ["x", "bluesky"] as const,
};

describe("canonical create-request identity", () => {
  it("ignores platform order", async () => {
    const left = await canonicalCreateRequestFingerprint({
      content: base.content,
      platforms: ["x", "bluesky"],
    });
    const right = await canonicalCreateRequestFingerprint({
      content: base.content,
      platforms: ["bluesky", "x"],
    });
    expect(left).toBe(right);
  });

  it("keeps duplicate platforms significant like the existing rule", async () => {
    const single = await canonicalCreateRequestFingerprint({ content: "c", platforms: ["x"] });
    const doubled = await canonicalCreateRequestFingerprint({ content: "c", platforms: ["x", "x"] });
    expect(single).not.toBe(doubled);
  });

  it("compares content exactly, with no normalization", async () => {
    const plain = await canonicalCreateRequestFingerprint({ content: "hello", platforms: ["x"] });
    const padded = await canonicalCreateRequestFingerprint({ content: " hello ", platforms: ["x"] });
    const cased = await canonicalCreateRequestFingerprint({ content: "Hello", platforms: ["x"] });
    expect(plain).not.toBe(padded);
    expect(plain).not.toBe(cased);
  });

  it("treats per-platform overrides as identity, including unselected platforms", async () => {
    const none = await canonicalCreateRequestFingerprint({ content: "c", platforms: ["x"] });
    const selected = await canonicalCreateRequestFingerprint({
      content: "c",
      platforms: ["x"],
      overrides: { x: { content: "x only" } },
    });
    const unselected = await canonicalCreateRequestFingerprint({
      content: "c",
      platforms: ["x"],
      overrides: { bluesky: { content: "bsky only" } },
    });
    expect(none).not.toBe(selected);
    expect(none).not.toBe(unselected);
  });

  it("requires a canonical scheduledAt and normalizes null and absent alike", async () => {
    const absent = await canonicalCreateRequestFingerprint({ content: "c", platforms: ["x"] });
    const explicitNull = await canonicalCreateRequestFingerprint({
      content: "c",
      platforms: ["x"],
      scheduledAt: null,
    });
    expect(absent).toBe(explicitNull);
    expect(() =>
      canonicalCreateRequestBytes({
        content: "c",
        platforms: ["x"],
        scheduledAt: "2026-09-23T00:00:00Z",
      }),
    ).toThrow(InvalidContractInputError);
  });

  it("produces a stable, non-reversible-length fingerprint", async () => {
    const first = await canonicalCreateRequestFingerprint({
      content: "c",
      platforms: ["x"],
    });
    const second = await canonicalCreateRequestFingerprint({
      content: "c",
      platforms: ["x"],
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the documented Idempotency-Key form only", () => {
    expect(isCreateIdempotencyKey("abc.def_1:-2")).toBe(true);
    expect(isCreateIdempotencyKey("a".repeat(128))).toBe(true);
    expect(isCreateIdempotencyKey("a".repeat(129))).toBe(false);
    expect(isCreateIdempotencyKey("bad key")).toBe(false);
    expect(isCreateIdempotencyKey("bad/key")).toBe(false);
    expect(isCreateIdempotencyKey("")).toBe(false);
    expect(isCreateIdempotencyKey(42)).toBe(false);
  });
});
