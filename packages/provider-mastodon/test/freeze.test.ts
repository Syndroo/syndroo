import { describe, expect, it } from "vitest";

import { findAuthKeys, isDeepFrozen } from "@syndroo/provider-sdk/testing";

import plugin, { MastodonProviderError, characterCount } from "../src/index.js";
import {
  DEFAULT_VISIBILITY,
  INSTANCE_LIMIT,
  SMALL_INSTANCE,
  SMALL_INSTANCE_LIMIT,
  TEST_INSTANCE,
  UNSEEDED_INSTANCE,
  freezeInput,
} from "./fixtures.js";

/** Freeze with the supplied overrides and return the raised provider error. */
function freezeError(overrides: Parameters<typeof freezeInput>[0]): MastodonProviderError {
  try {
    plugin.freeze(freezeInput(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(MastodonProviderError);
    return error as MastodonProviderError;
  }
  throw new Error("expected freeze to reject the input");
}

describe("mastodon freeze", () => {
  it("compiles the status payload deterministically", () => {
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

    // The payload is exactly the create-status body the API accepts.
    expect(first.payload).toEqual({
      status: "Hello from Syndroo on Mastodon.",
      visibility: DEFAULT_VISIBILITY,
    });

    expect(findAuthKeys(first)).toEqual([]);
    expect(isDeepFrozen(first)).toBe(true);
  });

  it("renders a complete preview that mirrors the effective content and options", () => {
    const frozen = plugin.freeze(freezeInput({ text: "Preview me.", visibility: "unlisted" }));

    expect(frozen.effectiveContent).toEqual({ text: "Preview me." });
    expect(frozen.effectiveOptions).toEqual({ visibility: "unlisted" });
    expect(frozen.preview.content).toEqual(frozen.effectiveContent);
    expect(frozen.preview.fields).toEqual([
      { name: "visibility", value: "unlisted" },
      { name: "max_characters", value: INSTANCE_LIMIT },
    ]);
  });

  it("never reads a clock: now changes nothing in the frozen payload", () => {
    const early = plugin.freeze(freezeInput({ now: "2026-10-08T00:00:00.000Z" }));
    const late = plugin.freeze(freezeInput({ now: "2027-01-02T12:30:00.000Z" }));

    expect(JSON.stringify(early)).toBe(JSON.stringify(late));
  });

  it("enforces the instance limit read at connect time, never a hardcoded number", () => {
    // The small instance reported a 12-character limit during the fixtures' seed.
    const ok = plugin.freeze(freezeInput({ origin: SMALL_INSTANCE, text: "a".repeat(SMALL_INSTANCE_LIMIT) }));
    expect((ok.payload.status as string).length).toBe(SMALL_INSTANCE_LIMIT);
    expect(ok.preview.fields).toEqual([
      { name: "visibility", value: DEFAULT_VISIBILITY },
      { name: "max_characters", value: SMALL_INSTANCE_LIMIT },
    ]);

    const over = freezeError({ origin: SMALL_INSTANCE, text: "a".repeat(SMALL_INSTANCE_LIMIT + 1) });
    expect(over.code).toBe("text_too_long");
    expect(over.message).toContain(SMALL_INSTANCE);

    // The default instance's own limit is what binds there, not 500 by fiat.
    expect(freezeError({ origin: TEST_INSTANCE, text: "a".repeat(INSTANCE_LIMIT + 1) }).code).toBe(
      "text_too_long",
    );
  });

  it("fails closed when the instance limit was never read", () => {
    const error = freezeError({ origin: UNSEEDED_INSTANCE });
    expect(error.code).toBe("limit_unavailable");
  });

  it("rejects missing or empty text and a missing visibility", () => {
    expect(freezeError({ text: "" }).code).toBe("text_missing");
    expect(freezeError({ visibility: "" }).code).toBe("visibility_missing");
  });

  it("counts code points for the limit, a documented approximation of characters", () => {
    expect(characterCount("hello")).toBe(5);
    expect(characterCount("日本語")).toBe(3);
    // A ZWJ family emoji is one grapheme but seven code points.
    expect(characterCount("👨‍👩‍👧‍👦")).toBe(7);
  });

  it("exposes the effective options but never a credential-shaped key", () => {
    const frozen = plugin.freeze(freezeInput());
    expect(Object.keys(frozen.effectiveOptions)).toEqual(["visibility"]);
    expect(findAuthKeys(frozen.preview)).toEqual([]);
  });
});
