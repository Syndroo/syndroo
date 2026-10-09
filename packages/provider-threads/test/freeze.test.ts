import { describe, expect, it } from "vitest";

import { findAuthKeys, isDeepFrozen } from "@syndroo/provider-sdk/testing";
import type { JsonObject } from "@syndroo/provider-sdk";

import plugin, {
  MAX_PAYLOAD_BYTES,
  THREADS_AUTO_PUBLISH_TEXT,
  THREADS_MEDIA_TYPE_TEXT,
  ThreadsProviderError,
  utf8ByteLength,
} from "../src/index.js";
import { freezeInput, postOptions } from "./fixtures.js";

/** Freeze with the supplied options and return the raised provider error. */
function freezeError(options: JsonObject): ThreadsProviderError {
  try {
    plugin.freeze(freezeInput({ options }));
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadsProviderError);
    return error as ThreadsProviderError;
  }
  throw new Error("expected freeze to reject the options");
}

describe("threads freeze", () => {
  it("compiles the single-call request parameters deterministically", () => {
    const input = freezeInput();
    const snapshot = structuredClone(input);
    const first = plugin.freeze(input);
    const second = plugin.freeze(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(input).toEqual(snapshot);

    // The payload is exactly the one-call text parameters.
    expect(first.payload).toEqual({
      text: "Hello from Syndroo on Threads.",
      media_type: THREADS_MEDIA_TYPE_TEXT,
      auto_publish_text: THREADS_AUTO_PUBLISH_TEXT,
    });
    expect(first.effectiveOptions).toEqual({ text: "Hello from Syndroo on Threads." });

    expect(findAuthKeys(first)).toEqual([]);
    expect(isDeepFrozen(first)).toBe(true);
  });

  it("pins media_type and auto_publish_text into the preview", () => {
    const frozen = plugin.freeze(freezeInput());
    expect(frozen.preview.fields).toEqual([
      { name: "text", value: "Hello from Syndroo on Threads." },
      { name: "media_type", value: "TEXT" },
      { name: "auto_publish_text", value: true },
    ]);
    // Every effective option is exposed as a preview field.
    const names = frozen.preview.fields.map((field) => field.name);
    for (const key of Object.keys(frozen.effectiveOptions)) {
      expect(names).toContain(key);
    }
  });

  it("never reads a clock: now changes nothing in the frozen payload", () => {
    const early = plugin.freeze(freezeInput({ now: "2026-10-08T00:00:00.000Z" }));
    const late = plugin.freeze(freezeInput({ now: "2027-01-02T12:30:00.000Z" }));

    expect(JSON.stringify(early)).toBe(JSON.stringify(late));
  });

  it("preserves shared content verbatim while the post text comes from the option", () => {
    const frozen = plugin.freeze(freezeInput({ contentText: "Shared summary." }));
    expect(frozen.effectiveContent).toEqual({ text: "Shared summary." });
    expect(frozen.preview.content).toEqual({ text: "Shared summary." });
    expect(frozen.payload.text).toBe("Hello from Syndroo on Threads.");

    // A post-only target may send empty shared content.
    expect(plugin.freeze(freezeInput()).effectiveContent).toEqual({});
  });

  it("rejects missing or empty text", () => {
    expect(freezeError({}).code).toBe("text_missing");
    expect(freezeError(postOptions({ text: "" })).code).toBe("text_missing");
  });

  it("rejects a request past the transport-safety ceiling rather than truncating", () => {
    const huge = "a".repeat(MAX_PAYLOAD_BYTES + 1);
    expect(utf8ByteLength(huge)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const error = freezeError(postOptions({ text: huge }));
    expect(error.code).toBe("payload_too_large");
    expect(error.message).toContain(String(MAX_PAYLOAD_BYTES));
  });

  it("counts UTF-8 bytes, not code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("日本語")).toBe(9);
    expect(utf8ByteLength("👋")).toBe(4);
  });
});
