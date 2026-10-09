import { describe, expect, it } from "vitest";

import { findAuthKeys, isDeepFrozen } from "@syndroo/provider-sdk/testing";
import type { JsonObject } from "@syndroo/provider-sdk";

import plugin, { DevtoProviderError } from "../src/index.js";
import { DEVTO_ACCOUNT, articleOptions, freezeInput } from "./fixtures.js";

/** Freeze with the supplied options and return the raised provider error. */
function freezeError(options: JsonObject): DevtoProviderError {
  try {
    plugin.freeze(freezeInput({ options }));
  } catch (error) {
    expect(error).toBeInstanceOf(DevtoProviderError);
    return error as DevtoProviderError;
  }
  throw new Error("expected freeze to reject the options");
}

describe("devto freeze", () => {
  it("compiles the create-article request deterministically", () => {
    const input = freezeInput();
    const snapshot = structuredClone(input);
    const first = plugin.freeze(input);
    const second = plugin.freeze(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(input).toEqual(snapshot);

    // The payload is exactly the verified create-article body shape.
    expect(first.payload).toEqual({
      article: {
        title: "Introducing Syndroo",
        body_markdown: "# Introducing Syndroo\n\nA full Markdown article.",
        published: true,
        tags: ["syndroo", "typescript"],
        canonical_url: "https://example.com/posts/syndroo",
        description: "A full Markdown article.",
      },
    });

    expect(findAuthKeys(first)).toEqual([]);
    expect(isDeepFrozen(first)).toBe(true);
  });

  it("emits only the article fields it was given", () => {
    const frozen = plugin.freeze(
      freezeInput({ options: { title: "Minimal article", body_markdown: "Just a body." } }),
    );

    expect(frozen.payload).toEqual({
      article: { title: "Minimal article", body_markdown: "Just a body.", published: true },
    });
    // A publication is always explicit; published defaults to true in the preview.
    expect(frozen.effectiveOptions).toEqual({
      title: "Minimal article",
      body_markdown: "Just a body.",
      published: true,
    });
  });

  it("never reads a clock: now changes nothing in the frozen payload", () => {
    const early = plugin.freeze(freezeInput({ now: "2026-10-08T00:00:00.000Z" }));
    const late = plugin.freeze(freezeInput({ now: "2027-01-02T12:30:00.000Z" }));

    expect(JSON.stringify(early)).toBe(JSON.stringify(late));
  });

  it("allows an article-only target to send empty shared content", () => {
    const frozen = plugin.freeze(freezeInput());
    expect(frozen.effectiveContent).toEqual({});
    expect(frozen.preview.content).toEqual({});
  });

  it("preserves shared content verbatim while the body comes from the option", () => {
    const frozen = plugin.freeze(
      freezeInput({
        text: "Shared summary.",
        options: { title: "Shared target", body_markdown: "The option body." },
      }),
    );

    expect(frozen.effectiveContent).toEqual({ text: "Shared summary." });
    expect(frozen.preview.content).toEqual({ text: "Shared summary." });
    expect(frozen.payload).toEqual({
      article: { title: "Shared target", body_markdown: "The option body.", published: true },
    });
  });

  it("exposes every effective option as a preview field", () => {
    const frozen = plugin.freeze(freezeInput());
    expect(frozen.preview.fields.map((field) => field.name)).toEqual([
      "title",
      "body_markdown",
      "published",
      "tags",
      "canonical_url",
      "description",
    ]);
    expect(frozen.preview.fields[2]).toEqual({ name: "published", value: true });
  });

  it("rejects a missing or empty title", () => {
    expect(freezeError({ body_markdown: "body" }).code).toBe("title_missing");
    expect(freezeError({ title: "", body_markdown: "body" }).code).toBe("title_missing");
  });

  it("rejects a missing or empty body", () => {
    expect(freezeError({ title: "title" }).code).toBe("body_missing");
    expect(freezeError({ title: "title", body_markdown: "" }).code).toBe("body_missing");
  });

  it("rejects a published:false draft shape", () => {
    const error = freezeError({ ...articleOptions(), published: false });
    expect(error.code).toBe("draft_not_supported");
  });

  it("rejects a malformed tags option instead of coercing it", () => {
    expect(freezeError({ ...articleOptions(), tags: "syndroo" }).code).toBe("tags_invalid");
    expect(freezeError({ ...articleOptions(), tags: ["ok", 7] }).code).toBe("tags_invalid");
    expect(freezeError({ ...articleOptions(), tags: [""] }).code).toBe("tags_invalid");
  });

  it("does not invent a title length limit", () => {
    const longTitle = "T".repeat(5000);
    const frozen = plugin.freeze(
      freezeInput({ options: { title: longTitle, body_markdown: "body" } }),
    );
    expect((frozen.payload.article as JsonObject).title).toBe(longTitle);

    // Titles are passed through verbatim: no trimming, no rewriting.
    const padded = plugin.freeze(freezeInput({ options: { title: "  spaced  ", body_markdown: "body" } }));
    expect((padded.payload.article as JsonObject).title).toBe("  spaced  ");
  });
});
