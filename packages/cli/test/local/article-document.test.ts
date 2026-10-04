import { describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import {
  MAX_LOCAL_ARTICLE_TAGS,
  MAX_LOCAL_ARTICLE_TITLE_CODE_POINTS,
  MAX_LOCAL_CANONICAL_URL_CHARS,
  MAX_LOCAL_SOURCE_BYTES,
  contentOptionsFor,
  parseLocalPublishDocument,
  requiresSchema2Record,
} from "../../src/local/document.js";

/**
 * B1: the explicit v2 article document.
 *
 * Every case is an input-shape check; none of them reaches a provider, a
 * credential source, or the network.
 */

const BODY = "# 安全发布工作流\n\n先验证目标账号，再执行已确认的发布。";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return (error as CliError).code;
  }

  throw new Error("expected a CliError");
}

interface ArticleFields {
  readonly key?: string;
  readonly content?: string;
  readonly platforms?: readonly unknown[];
  readonly overrides?: unknown;
  readonly schemaVersion?: unknown;
}

function articleText(fields: ArticleFields = {}): string {
  const {
    key = "article-2026-10-04",
    content = "我整理了一个安全发布工作流。全文：https://example.com/posts/safe-publishing",
    platforms = ["bluesky", "mastodon", "devto"],
    overrides = {
      devto: {
        content: BODY,
        article: {
          title: "构建可验证的社媒发布工作流",
          tags: ["typescript", "opensource"],
          canonicalUrl: "https://example.com/posts/safe-publishing",
        },
      },
    },
    schemaVersion = 2,
  } = fields;

  return JSON.stringify({
    schemaVersion,
    key,
    content,
    platforms,
    overrides,
  });
}

describe("v2 article document", () => {
  it("accepts an explicit article and keeps every field byte for byte", () => {
    const document = parseLocalPublishDocument(articleText());
    const override = document.overrides?.["devto"];

    expect(document.schemaVersion).toBe(2);
    expect(document.platforms).toEqual(["bluesky", "mastodon", "devto"]);
    expect(override?.content).toBe(BODY);
    expect(override?.article).toEqual({
      title: "构建可验证的社媒发布工作流",
      tags: ["typescript", "opensource"],
      canonicalUrl: "https://example.com/posts/safe-publishing",
    });

    const options = contentOptionsFor(document, "devto");

    expect(options).toEqual({ article: override?.article });
    expect(requiresSchema2Record("devto", options)).toBe(true);
    expect(requiresSchema2Record("bluesky", undefined)).toBe(false);
    expect(requiresSchema2Record("mastodon", undefined)).toBe(true);
  });

  it("requires an explicit devto override with body and article", () => {
    const missing = [
      { devto: { content: BODY } },
      { devto: { article: { title: "t" } } },
      {},
      { bluesky: { content: "summary only" } },
    ];

    for (const overrides of missing) {
      expect(
        codeOf(() =>
          parseLocalPublishDocument(articleText({ overrides })),
        ),
      ).toBe("INVALID_DOCUMENT");
    }
  });

  it("allows a v2 document that selects no devto target", () => {
    const document = parseLocalPublishDocument(
      JSON.stringify({
        schemaVersion: 2,
        key: "v2-text-only",
        content: "text-only v2 document",
        platforms: ["bluesky", "mastodon"],
      }),
    );

    expect(document.schemaVersion).toBe(2);
    expect(document.platforms).toEqual(["bluesky", "mastodon"]);
    expect(document.overrides).toBeUndefined();
    // No provider carries article options, so the record stays schema 1.
    expect(requiresSchema2Record("bluesky", undefined)).toBe(false);
  });

  it("rejects devto without schemaVersion 2", () => {
    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          articleText({ schemaVersion: 1, platforms: ["devto"] }),
        ),
      ),
    ).toBe("INVALID_DOCUMENT");

    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          articleText({ schemaVersion: 3, platforms: ["devto"] }),
        ),
      ),
    ).toBe("INVALID_DOCUMENT");
  });

  it("bounds the title at 1-128 code points", () => {
    const title = (value: string): string =>
      articleText({
        overrides: {
          devto: { content: BODY, article: { title: value } },
        },
      });

    expect(
      parseLocalPublishDocument(title("汉".repeat(128))).overrides?.["devto"]
        ?.article?.title,
    ).toBe("汉".repeat(128));
    expect(codeOf(() => parseLocalPublishDocument(title("汉".repeat(129))))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(codeOf(() => parseLocalPublishDocument(title("")))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(codeOf(() => parseLocalPublishDocument(title("   ")))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(codeOf(() => parseLocalPublishDocument(title("bad\u001btitle")))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(MAX_LOCAL_ARTICLE_TITLE_CODE_POINTS).toBe(128);
  });

  it("bounds tags at four unique lowercase alphanumerics and keeps order", () => {
    const withTags = (tags: readonly string[]): string =>
      articleText({
        overrides: {
          devto: { content: BODY, article: { title: "t", tags } },
        },
      });

    expect(
      parseLocalPublishDocument(withTags(["b", "a", "c", "d"])).overrides?.[
        "devto"
      ]?.article?.tags,
    ).toEqual(["b", "a", "c", "d"]);

    for (const tags of [
      ["a", "b", "c", "d", "e"],
      ["a", "a"],
      ["Upper"],
      ["with-hyphen"],
      ["a".repeat(31)],
    ]) {
      expect(codeOf(() => parseLocalPublishDocument(withTags(tags)))).toBe(
        "INVALID_DOCUMENT",
      );
    }

    expect(MAX_LOCAL_ARTICLE_TAGS).toBe(4);
  });

  it("keeps an explicit empty tag list as zero tags", () => {
    const document = parseLocalPublishDocument(
      articleText({
        overrides: {
          devto: { content: BODY, article: { title: "t", tags: [] } },
        },
      }),
    );

    expect(document.overrides?.["devto"]?.article).toEqual({
      title: "t",
      tags: [],
    });
    // Zero tags is an approved input, not an omitted field.
    expect(
      Object.hasOwn(document.overrides?.["devto"]?.article ?? {}, "tags"),
    ).toBe(true);
  });

  it("bounds canonicalUrl to an absolute HTTPS URL without userinfo", () => {
    const withUrl = (canonicalUrl: unknown): string =>
      articleText({
        overrides: {
          devto: { content: BODY, article: { title: "t", canonicalUrl } },
        },
      });

    expect(
      parseLocalPublishDocument(withUrl("https://example.com/a")).overrides?.[
        "devto"
      ]?.article?.canonicalUrl,
    ).toBe("https://example.com/a");

    for (const bad of [
      "http://example.com/a",
      "https://user:pass@example.com/a",
      "https://example.com/" + "a".repeat(MAX_LOCAL_CANONICAL_URL_CHARS),
      "not a url",
      " https://example.com/a",
      "https://example.com/a\u0000",
      "",
    ]) {
      expect(codeOf(() => parseLocalPublishDocument(withUrl(bad)))).toBe(
        "INVALID_DOCUMENT",
      );
    }
  });

  it("rejects YAML front matter and Liquid directives", () => {
    const body = (content: string): string =>
      articleText({
        overrides: {
          devto: { content, article: { title: "t" } },
        },
      });

    for (const content of [
      "---\ntitle: injected\n---\nbody",
      "\n\n   ---\nbody",
      "{% if x %}y{% endif %}",
      "text %}{% end",
    ]) {
      expect(codeOf(() => parseLocalPublishDocument(body(content)))).toBe(
        "INVALID_DOCUMENT",
      );
    }

    // A fence that is not the first non-blank line is ordinary Markdown.
    expect(
      parseLocalPublishDocument(body("intro\n\n---\n\nmore")).overrides?.[
        "devto"
      ]?.content,
    ).toBe("intro\n\n---\n\nmore");
  });

  it("bounds the article body and the whole source", () => {
    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          articleText({
            overrides: {
              devto: {
                content: "a".repeat(10_001),
                article: { title: "t" },
              },
            },
          }),
        ),
      ),
    ).toBe("INVALID_DOCUMENT");

    const huge = articleText({
      overrides: {
        devto: {
          content: "a".repeat(MAX_LOCAL_SOURCE_BYTES),
          article: { title: "t" },
        },
      },
    });

    expect(codeOf(() => parseLocalPublishDocument(huge))).toBe("INPUT_TOO_LARGE");
  });

  it("keeps strict field sets for the article", () => {
    for (const article of [
      { title: "t", series: "x" },
      { title: "t", organization_id: 1 },
      { title: "t", media: [] },
      { tags: ["a"] },
      "not an object",
    ]) {
      expect(
        codeOf(() =>
          parseLocalPublishDocument(
            articleText({
              overrides: { devto: { content: BODY, article } },
            }),
          ),
        ),
      ).toBe("INVALID_DOCUMENT");
    }
  });

  it("still refuses an article field under v1", () => {
    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          JSON.stringify({
            schemaVersion: 1,
            key: "k",
            content: "c",
            platforms: ["bluesky"],
            overrides: { bluesky: { content: "c", article: { title: "t" } } },
          }),
        ),
      ),
    ).toBe("INVALID_DOCUMENT");
  });
});
