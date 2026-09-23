import { describe, expect, it } from "vitest";

import { MAX_RETRY_AFTER_MS, parseRetryAfter } from "../src/index.js";

const now = new Date("2026-09-23T00:00:00.000Z");

describe("parseRetryAfter", () => {
  it("accepts delta-seconds and clamps to the 24h bound", () => {
    expect(parseRetryAfter("120", { now })).toBe("2026-09-23T00:02:00.000Z");
    expect(parseRetryAfter(String(48 * 60 * 60), { now })).toBe(
      new Date(now.getTime() + MAX_RETRY_AFTER_MS).toISOString(),
    );
  });

  it("accepts a valid IMF-fixdate HTTP date", () => {
    expect(parseRetryAfter("Wed, 23 Sep 2026 01:00:00 GMT", { now })).toBe(
      "2026-09-23T01:00:00.000Z",
    );
  });

  it("rejects arbitrary Date.parse inputs that are not HTTP dates", () => {
    for (const value of [
      "2026-09-23T01:00:00.000Z",
      "Sep 23 2026 01:00:00",
      "Wed, 23 September 2026 01:00:00 GMT",
      "Wed, 23 Sep 26 01:00:00 GMT",
    ]) {
      expect(parseRetryAfter(value, { now })).toBeUndefined();
    }
  });

  it("ignores missing, empty, negative and past values", () => {
    expect(parseRetryAfter(null, { now })).toBeUndefined();
    expect(parseRetryAfter(undefined, { now })).toBeUndefined();
    expect(parseRetryAfter("   ", { now })).toBeUndefined();
    expect(parseRetryAfter("-5", { now })).toBeUndefined();
    expect(parseRetryAfter("0", { now })).toBeUndefined();
    expect(parseRetryAfter("Tue, 22 Sep 2026 00:00:00 GMT", { now })).toBeUndefined();
  });

  it("rejects an out-of-range maximum instead of producing a bogus instant", () => {
    for (const maxDelayMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, MAX_RETRY_AFTER_MS + 1]) {
      expect(() => parseRetryAfter("60", { now, maxDelayMs })).toThrow(TypeError);
    }
  });
});
