import { describe, expect, it } from "vitest";

import { PLATFORMS, PublishError, isPlatform } from "../src/index.js";

describe("core domain", () => {
  it("keeps the v0.1 platform list fixed", () => {
    expect(PLATFORMS).toEqual([
      "x",
      "threads",
      "bluesky",
      "tumblr",
      "mastodon",
      "linkedin",
      "nostr",
    ]);
    expect(isPlatform("bluesky")).toBe(true);
    expect(isPlatform("instagram")).toBe(false);
  });

  it("preserves publish error code and ambiguity", () => {
    const error = new PublishError("Timed out", "NETWORK", true);

    expect(error).toMatchObject({
      name: "PublishError",
      code: "NETWORK",
      ambiguous: true,
    });
  });

  it("keeps the three-argument constructor call valid without retry hint", () => {
    const error = new PublishError("Rejected", "INVALID_CONTENT", false, {
      cause: new Error("raw provider detail"),
    });

    expect(error.retryAfterAt).toBeUndefined();
    // The raw cause stays available to the caller that created it but is never
    // part of any public projection by itself.
    expect((error.cause as Error).message).toBe("raw provider detail");
  });

  it("carries a normalized retry hint when one was supplied", () => {
    const error = new PublishError("Rate limited", "RATE_LIMIT", false, {
      retryAfterAt: "2026-09-23T01:00:00.000Z",
    });

    expect(error.retryAfterAt).toBe("2026-09-23T01:00:00.000Z");
    expect(error).toMatchObject({
      name: "PublishError",
      code: "RATE_LIMIT",
      ambiguous: false,
    });
  });
});
