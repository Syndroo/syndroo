import { describe, expect, it } from "vitest";

import { LocalProviderError, type LocalInstanceCapabilities } from "@syndroo/core";

import {
  assertMastodonContentFits,
  assertMastodonStatusText,
  countMastodonCharacters,
  extractMastodonUrls,
} from "../src/index.js";

const RESERVED = 23;

function capabilities(overrides: Partial<LocalInstanceCapabilities> = {}): LocalInstanceCapabilities {
  return { maxCharacters: 500, charactersReservedPerUrl: RESERVED, ...overrides };
}

function count(content: string, reserved = RESERVED): number {
  return countMastodonCharacters(content, reserved);
}

/** Plain grapheme length: what a text must count as when no concession applies. */
function plain(text: string): number {
  return [...text].length;
}

describe("grapheme counting", () => {
  it.each([
    { label: "ascii", text: "abc", expected: 3 },
    { label: "skin-tone emoji", text: "👍🏽", expected: 1 },
    { label: "ZWJ family emoji", text: "👨‍👩‍👧‍👦", expected: 1 },
    { label: "regional flag", text: "🇯🇵", expected: 1 },
    { label: "combining mark", text: "e\u0301", expected: 1 },
    { label: "CJK", text: "你好世界", expected: 4 },
    { label: "emoji between letters", text: "a👨‍👩‍👧‍👦b", expected: 3 },
    { label: "keycap", text: "1️⃣", expected: 1 },
  ])("counts $label in grapheme clusters", ({ text, expected }) => {
    expect(count(text)).toBe(expected);
  });
});

describe("URL recognition is conservative", () => {
  it.each([
    "https://%%%%",
    "https://",
    "https://.foo",
    "https://-foo.com",
    "https://foo",
    "https://foo.123",
    "https://bad-.com",
    "xhttps://example.com",
    "see https://foo bar",
  ])("counts %s as plain text, not a URL discount", text => {
    expect(count(text)).toBe(plain(text));
  });

  it("grants the discount only to the recognized URL part", () => {
    expect(count("see https://example.com/path")).toBe(plain("see ") + RESERVED);
    expect(count("see http://example.com/path")).toBe(plain("see ") + RESERVED);
    expect(count("see https://example.com/path", 10)).toBe(plain("see ") + 10);
    expect(count("https://example.com,then")).toBe(RESERVED + plain(",then"));
    expect(count("https://sub.example.co.uk:8443/a?b=1#c")).toBe(RESERVED);
    expect(count("https://192.168.1.1/x")).toBe(RESERVED);
    expect(count("https://[2001:db8::1]/x")).toBe(RESERVED);
    expect(count("https://xn--bcher-kva.example/x")).toBe(RESERVED);
    // A non-numeric port is not part of the recognized URL.
    expect(count("https://example.com:abc")).toBe(RESERVED + plain(":abc"));
  });

  it("keeps the URL text out of the grapheme total", () => {
    const long = "https://example.com/" + "a".repeat(300);

    expect(count(`x ${long}`)).toBe(2 + RESERVED);
  });

  it("counts an over-long URL as plain text instead of a discount", () => {
    const huge = "https://example.com/" + "a".repeat(3_000);

    expect(count(huge)).toBe(plain(huge));
  });

  it("trims trailing sentence punctuation from the URL", () => {
    expect(count("see https://example.com.")).toBe(plain("see ") + RESERVED + 1);
    expect(count("go https://example.com, now")).toBe(plain("go ") + RESERVED + plain(", now"));
    expect(count("q https://example.com?")).toBe(2 + RESERVED + 1);
  });

  it("keeps balanced brackets inside a URL and trims unbalanced ones", () => {
    expect(count("(https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(2 + RESERVED);
    expect(count("[https://example.com/a]")).toBe(2 + RESERVED);
    expect(count("https://example.com/a(b)")).toBe(RESERVED);
  });

  it("reports the exact URL span", () => {
    const text = "a https://x.test/p! b";
    const spans = extractMastodonUrls(text);

    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("https://x.test/p");
  });

  it("trims a long run of unbalanced brackets without losing the URL discount", () => {
    const text = "https://example.com/" + ")".repeat(2_000);
    const started = Date.now();

    // The URL is trimmed back to `https://example.com/`; the brackets that were
    // not part of it stay in the text and are counted normally.
    expect(count(text)).toBe(RESERVED + 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("counts an over-cap candidate as plain text instead of trimming it", () => {
    const text = "https://example.com/" + ")".repeat(3_000);

    expect(count(text)).toBe(plain(text));
  });
});

describe("mention recognition is conservative", () => {
  it.each([
    "@alice@foo",
    "@alice@example.",
    "@alice@-bad.com",
    "@alice@foo.123",
    "@alice@bad-.com",
    "user@name@host.com",
    "x@name@host.com",
    "see/@alice@example.com",
  ])("counts %s as plain text, not a mention discount", text => {
    expect(count(text)).toBe(plain(text));
  });

  it("grants the mention discount to a valid host and boundary", () => {
    expect(count("@alice@example.com")).toBe(plain("@alice"));
    expect(count("hi @bob@x.social!")).toBe(plain("hi ") + plain("@bob") + 1);
    expect(count("(@alice@example.com)")).toBe(1 + plain("@alice") + 1);
  });

  it("keeps a local mention as plain text", () => {
    expect(count("@alice")).toBe(plain("@alice"));
  });

  it("does not double count a mention inside a URL", () => {
    expect(count("https://example.com/@alice")).toBe(RESERVED);
  });

  it("combines mentions, URLs, and plain text", () => {
    expect(count("hi @bob@x.social https://a.test/p")).toBe(
      plain("hi ") + plain("@bob") + 1 + RESERVED,
    );
  });
});

describe("CJK adjacency", () => {
  it("stops a URL at a CJK character instead of absorbing it", () => {
    expect(count("https://example.com你好")).toBe(RESERVED + plain("你好"));
  });

  it("still grants a mention adjacent to CJK text", () => {
    expect(count("你好@alice@example.com世界")).toBe(
      plain("你好") + plain("@alice") + plain("世界"),
    );
  });
});

describe("content gates", () => {
  it("accepts content at the limit and rejects one grapheme over", () => {
    expect(() => assertMastodonContentFits("abcde", capabilities({ maxCharacters: 5 }))).not.toThrow();
    expect(() => assertMastodonContentFits("abcdef", capabilities({ maxCharacters: 5 }))).toThrow(
      LocalProviderError,
    );
  });

  it("rejects a URL that exceeds a small instance limit", () => {
    let caught: unknown;

    try {
      assertMastodonContentFits("https://a.test/p", capabilities({ maxCharacters: 10 }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LocalProviderError);
    expect((caught as LocalProviderError).code).toBe("INVALID_CONTENT");
  });

  it.each([
    { label: "zero max characters", caps: { maxCharacters: 0 } },
    { label: "fractional max characters", caps: { maxCharacters: 1.5 } },
    { label: "unsafe max characters", caps: { maxCharacters: Number.MAX_SAFE_INTEGER + 1 } },
    { label: "zero reserved length", caps: { charactersReservedPerUrl: 0 } },
    { label: "fractional reserved length", caps: { charactersReservedPerUrl: 22.5 } },
    { label: "unsafe reserved length", caps: { charactersReservedPerUrl: Number.MAX_SAFE_INTEGER + 1 } },
  ])("fails closed on $label", ({ caps }) => {
    let caught: unknown;

    try {
      assertMastodonContentFits("hello", capabilities(caps));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LocalProviderError);
    expect((caught as LocalProviderError).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed in the pure counter for a reserved length of %s",
    reserved => {
      expect(countMastodonCharacters("hello https://example.com", reserved)).toBe(
        Number.POSITIVE_INFINITY,
      );
    },
  );

  it("rejects empty and control-bearing status text", () => {
    expect(() => assertMastodonStatusText("")).toThrow(LocalProviderError);
    expect(() => assertMastodonStatusText("   ")).toThrow(LocalProviderError);
    expect(() => assertMastodonStatusText("a\u0000b")).toThrow(LocalProviderError);
    expect(() => assertMastodonStatusText("a\u007fb")).toThrow(LocalProviderError);
    expect(() => assertMastodonStatusText("hello\nworld")).not.toThrow();
    expect(() => assertMastodonStatusText("tab\tok")).not.toThrow();
  });
});
