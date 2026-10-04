import { describe, expect, it } from "vitest";

import { LocalProviderError } from "@syndroo/core";

import {
  DEVTO_MAX_BODY_CODE_POINTS,
  DEVTO_MAX_TITLE_CODE_POINTS,
  buildDevtoArticlePayload,
  devtoPayloadMatches,
  devtoTargetId,
  parseDevtoTargetId,
  readDevtoUserId,
  validateDevtoArticle,
  validateDevtoBody,
  validateDevtoCanonicalUrl,
  validateDevtoContentOptions,
  validateDevtoTags,
  validateDevtoTitle,
} from "../src/index.js";

const TITLE = "A bounded article";
const BODY = "# Heading\n\nBody text.";

function expectInvalid(run: () => unknown): void {
  let caught: unknown;

  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(LocalProviderError);
  expect((caught as LocalProviderError).code).toBe("INVALID_CONTENT");
}

describe("title limits", () => {
  it("accepts a title at the code-point limit", () => {
    const title = "t".repeat(DEVTO_MAX_TITLE_CODE_POINTS);

    expect(validateDevtoTitle(title)).toBe(title);
  });

  it("counts code points, not UTF-16 units", () => {
    const title = "😀".repeat(DEVTO_MAX_TITLE_CODE_POINTS);

    expect(validateDevtoTitle(title)).toBe(title);
  });

  it.each([
    { label: "one code point over", value: "t".repeat(DEVTO_MAX_TITLE_CODE_POINTS + 1) },
    { label: "blank", value: "   " },
    { label: "empty", value: "" },
    { label: "a control character", value: "bad\u0000title" },
    { label: "a non-string", value: 42 },
  ])("rejects $label", ({ value }) => {
    expectInvalid(() => validateDevtoTitle(value));
  });
});

describe("tag limits", () => {
  it("keeps an explicit empty list distinct from omitted tags", () => {
    expect(validateDevtoTags([])).toEqual([]);
    expect(validateDevtoTags(undefined)).toBeUndefined();
  });

  it("accepts four tags and preserves their order", () => {
    expect(validateDevtoTags(["typescript", "opensource", "web", "dev"])).toEqual([
      "typescript",
      "opensource",
      "web",
      "dev",
    ]);
  });

  it.each([
    { label: "five tags", value: ["a", "b", "c", "d", "e"] },
    { label: "a duplicate", value: ["a", "a"] },
    { label: "uppercase", value: ["TypeScript"] },
    { label: "a hyphen", value: ["type-script"] },
    { label: "31 characters", value: ["a".repeat(31)] },
    { label: "an empty tag", value: [""] },
    { label: "a non-string", value: [1] },
    { label: "a non-array", value: "typescript" },
  ])("rejects $label", ({ value }) => {
    expectInvalid(() => validateDevtoTags(value));
  });

  it("accepts a 30-character tag", () => {
    expect(validateDevtoTags(["a".repeat(30)])).toEqual(["a".repeat(30)]);
  });
});

describe("canonical URL", () => {
  it("accepts an absolute HTTPS URL", () => {
    expect(validateDevtoCanonicalUrl("https://example.com/posts/1")).toBe(
      "https://example.com/posts/1",
    );
    expect(validateDevtoCanonicalUrl(undefined)).toBeUndefined();
  });

  it.each([
    { label: "http", value: "http://example.com/posts/1" },
    { label: "userinfo", value: "https://user:pass@example.com/posts/1" },
    { label: "a relative path", value: "/posts/1" },
    { label: "surrounding whitespace", value: " https://example.com/posts/1 " },
    { label: "a control character", value: "https://example.com/\u0000" },
    { label: "an over-long value", value: `https://example.com/${"a".repeat(2_048)}` },
    { label: "an empty string", value: "" },
  ])("rejects $label", ({ value }) => {
    expectInvalid(() => validateDevtoCanonicalUrl(value));
  });
});

describe("body limits", () => {
  it("accepts a body at the code-point limit", () => {
    const body = "b".repeat(DEVTO_MAX_BODY_CODE_POINTS);

    expect(validateDevtoBody(body)).toBe(body);
  });

  it("rejects one code point over", () => {
    expectInvalid(() => validateDevtoBody("b".repeat(DEVTO_MAX_BODY_CODE_POINTS + 1)));
  });

  it("rejects YAML front matter on the first non-blank line", () => {
    expectInvalid(() => validateDevtoBody("\n\n---\ntitle: x\n---\n\nBody"));
  });

  it("allows a thematic break later in the body", () => {
    expect(validateDevtoBody("Intro\n\n---\n\nMore")).toContain("---");
  });

  it.each([
    { label: "a Liquid output", value: "hello {% raw %}" },
    { label: "a Liquid tag", value: "hello %}" },
    { label: "a control character", value: "bad\u0000body" },
    { label: "blank", value: "  " },
  ])("rejects $label", ({ value }) => {
    expectInvalid(() => validateDevtoBody(value));
  });
});

describe("article options", () => {
  it("rejects unknown article keys and unknown option keys", () => {
    expectInvalid(() => validateDevtoArticle({ title: TITLE, organization: "x" }));
    expectInvalid(() => validateDevtoContentOptions({ article: { title: TITLE }, draft: true }));
    expectInvalid(() => validateDevtoContentOptions({}));
  });

  it("returns a strict article object", () => {
    expect(
      validateDevtoContentOptions({
        article: { title: TITLE, tags: ["typescript"], canonicalUrl: "https://example.com/a" },
      }),
    ).toEqual({
      title: TITLE,
      tags: ["typescript"],
      canonicalUrl: "https://example.com/a",
    });
  });
});

describe("wire payload", () => {
  it("builds the exact public payload and omits optional fields", () => {
    expect(buildDevtoArticlePayload(BODY, { title: TITLE })).toEqual({
      article: { title: TITLE, body_markdown: BODY, published: true },
    });
  });

  it("keeps an explicit zero-tag list and preserves tag order", () => {
    expect(buildDevtoArticlePayload(BODY, { title: TITLE, tags: [] })).toEqual({
      article: { title: TITLE, body_markdown: BODY, published: true, tags: [] },
    });
    expect(buildDevtoArticlePayload(BODY, { title: TITLE, tags: ["b", "a"] })).toEqual({
      article: { title: TITLE, body_markdown: BODY, published: true, tags: ["b", "a"] },
    });
  });

  it("includes canonical_url only when supplied", () => {
    expect(
      buildDevtoArticlePayload(BODY, { title: TITLE, canonicalUrl: "https://example.com/a" }),
    ).toEqual({
      article: {
        title: TITLE,
        body_markdown: BODY,
        published: true,
        canonical_url: "https://example.com/a",
      },
    });
  });

  it("matches only the rebuilt payload", () => {
    const payload = buildDevtoArticlePayload(BODY, { title: TITLE, tags: ["a"] });

    expect(devtoPayloadMatches(payload, BODY, { title: TITLE, tags: ["a"] })).toBe(true);
    expect(
      devtoPayloadMatches(
        { article: { ...(payload["article"] as Record<string, unknown>), draft: true } },
        BODY,
        { title: TITLE, tags: ["a"] },
      ),
    ).toBe(false);
    expect(devtoPayloadMatches(payload, BODY, { title: TITLE, tags: ["b"] })).toBe(false);
    expect(devtoPayloadMatches(payload, "other body", { title: TITLE, tags: ["a"] })).toBe(false);
  });
});

describe("target identity", () => {
  it("round-trips a numeric id", () => {
    expect(devtoTargetId(1234567)).toBe("devto:1234567");
    expect(parseDevtoTargetId("devto:1234567")).toBe(1234567);
  });

  it.each([
    "devto:0",
    "devto:abc",
    "devto:5.0",
    "devto:-1",
    "devto:",
    "mastodon:5",
    "devto:12345678901234567890",
  ])("rejects %s", value => {
    expect(parseDevtoTargetId(value)).toBeNull();
  });

  it.each([
    { label: "a numeric string", value: "1234567" },
    { label: "a fraction", value: 1234.5 },
    { label: "zero", value: 0 },
    { label: "a negative id", value: -1 },
    { label: "an unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "null", value: null },
  ])("rejects $label as an identity id", ({ value }) => {
    expect(readDevtoUserId(value)).toBeNull();
  });

  it("refuses a non-positive id when building a target", () => {
    expect(() => devtoTargetId(0)).toThrow(LocalProviderError);
    expect(() => devtoTargetId(Number.MAX_SAFE_INTEGER + 1)).toThrow(LocalProviderError);
  });
});
