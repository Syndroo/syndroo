import { describe, expect, it } from "vitest";

import { findAuthKeys, isDeepFrozen } from "@syndroo/provider-sdk/testing";

import plugin, {
  BlueskyProviderError,
  MAX_TEXT_BYTES,
  MAX_TEXT_GRAPHEMES,
  POST_COLLECTION,
  POST_RECORD_TYPE,
  graphemeCount,
  utf8ByteLength,
} from "../src/index.js";
import { BLUESKY_ACCOUNT, freezeInput } from "./fixtures.js";

/** Freeze over-limit text and return the raised provider error. */
function freezeError(text: string): BlueskyProviderError {
  try {
    plugin.freeze(freezeInput({ text }));
  } catch (error) {
    expect(error).toBeInstanceOf(BlueskyProviderError);
    return error as BlueskyProviderError;
  }
  throw new Error("expected freeze to reject the content");
}

describe("bluesky freeze", () => {
  it("compiles the createRecord parameters deterministically", () => {
    const input = freezeInput();
    const snapshot = structuredClone(input);
    const first = plugin.freeze(input);
    const second = plugin.freeze(input);

    // Same input, twice: identical bytes and a fresh, frozen object.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);

    // Freeze is pure: the input it was handed is untouched.
    expect(input).toEqual(snapshot);

    // The payload is exactly the AT Protocol createRecord parameters.
    expect(first.payload).toEqual({
      repo: BLUESKY_ACCOUNT.accountId,
      collection: POST_COLLECTION,
      record: {
        type: POST_RECORD_TYPE,
        text: "Hello from Syndroo.",
        createdAt: input.now,
      },
    });

    // No auth-shaped key is present anywhere in the frozen payload.
    expect(findAuthKeys(first)).toEqual([]);
    expect(isDeepFrozen(first)).toBe(true);
  });

  it("takes createdAt from the freeze input, never from a clock", () => {
    const early = plugin.freeze(freezeInput({ now: "2026-10-08T00:00:00.000Z" }));
    const late = plugin.freeze(freezeInput({ now: "2026-10-09T12:30:00.000Z" }));

    const earlyRecord = early.payload.record as { createdAt: string };
    const lateRecord = late.payload.record as { createdAt: string };
    expect(earlyRecord.createdAt).toBe("2026-10-08T00:00:00.000Z");
    expect(lateRecord.createdAt).toBe("2026-10-09T12:30:00.000Z");
    expect(JSON.stringify(early)).not.toBe(JSON.stringify(late));
  });

  it("renders a complete preview that mirrors the effective content", () => {
    const frozen = plugin.freeze(freezeInput({ text: "Preview me." }));

    expect(frozen.effectiveContent).toEqual({ text: "Preview me." });
    expect(frozen.effectiveOptions).toEqual({});
    expect(frozen.preview.content).toEqual(frozen.effectiveContent);
    expect(frozen.preview.fields).toEqual([{ name: "text", value: "Preview me." }]);
  });

  it("rejects text longer than 3000 bytes with a stable reason", () => {
    // A single grapheme can be many bytes: one ZWJ family emoji is 25 bytes but
    // one grapheme, so 120 of them hit the byte limit well inside 300 graphemes.
    const family = "👨‍👩‍👧‍👦";
    expect(utf8ByteLength(family)).toBe(25);
    expect(graphemeCount(family)).toBe(1);
    expect(utf8ByteLength(family.repeat(120))).toBe(MAX_TEXT_BYTES);
    expect(graphemeCount(family.repeat(120))).toBeLessThan(MAX_TEXT_GRAPHEMES);

    // Accepts the byte boundary...
    expect(plugin.freeze(freezeInput({ text: family.repeat(120) }))).toBeDefined();

    // ...and rejects one byte over, and a plain multibyte string over the limit.
    const over = freezeError(family.repeat(121));
    expect(over.code).toBe("text_too_many_bytes");
    const multibyte = freezeError("あ".repeat(1001));
    expect(multibyte.code).toBe("text_too_many_bytes");
  });

  it("rejects text longer than 300 graphemes with a stable reason", () => {
    // "e" plus a combining acute is one grapheme but two code points; the byte
    // limit is nowhere near, so the grapheme limit is what rejects this.
    const combining = "e\u0301";
    expect(graphemeCount(combining)).toBe(1);
    expect(utf8ByteLength(combining.repeat(MAX_TEXT_GRAPHEMES + 1))).toBeLessThan(MAX_TEXT_BYTES);

    expect(plugin.freeze(freezeInput({ text: combining.repeat(MAX_TEXT_GRAPHEMES) }))).toBeDefined();
    expect(freezeError(combining.repeat(MAX_TEXT_GRAPHEMES + 1)).code).toBe("text_too_many_graphemes");

    // Plain ASCII binds on graphemes too: 301 bytes is fine, 301 graphemes is not.
    expect(freezeError("a".repeat(MAX_TEXT_GRAPHEMES + 1)).code).toBe("text_too_many_graphemes");
  });

  it("counts an emoji ZWJ sequence as one grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(graphemeCount(family)).toBe(1);
    expect(utf8ByteLength(family)).toBeGreaterThan(4);
  });
});
