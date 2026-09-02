import { describe, expect, it } from "vitest";

import { PLATFORMS, PublishError, isPlatform } from "../src/index.js";

describe("core domain", () => {
  it("keeps the v0.1 platform list fixed", () => {
    expect(PLATFORMS).toEqual([
      "x",
      "threads",
      "bluesky",
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
});
