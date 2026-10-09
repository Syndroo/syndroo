import { describe, expect, it } from "vitest";

import { findAuthKeys, isDeepFrozen } from "@syndroo/provider-sdk/testing";
import type { JsonObject } from "@syndroo/provider-sdk";

import plugin, {
  LIFECYCLE_STATE_PUBLISHED,
  LINKEDIN_VERSION,
  LinkedinProviderError,
  utf8ByteLength,
} from "../src/index.js";
import {
  DEFAULT_VISIBILITY,
  LINKEDIN_ACCOUNT,
  freezeInput,
  postOptions,
} from "./fixtures.js";

/** Freeze with the supplied options and return the raised provider error. */
function freezeError(options: JsonObject): LinkedinProviderError {
  try {
    plugin.freeze(freezeInput({ options }));
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedinProviderError);
    return error as LinkedinProviderError;
  }
  throw new Error("expected freeze to reject the options");
}

describe("linkedin freeze", () => {
  it("compiles the rest/posts body deterministically", () => {
    const input = freezeInput();
    const snapshot = structuredClone(input);
    const first = plugin.freeze(input);
    const second = plugin.freeze(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(input).toEqual(snapshot);

    expect(first.payload).toEqual({
      author: `urn:li:person:${LINKEDIN_ACCOUNT.accountId}`,
      commentary: "Hello from Syndroo on LinkedIn.",
      visibility: DEFAULT_VISIBILITY,
      lifecycleState: LIFECYCLE_STATE_PUBLISHED,
    });

    expect(findAuthKeys(first)).toEqual([]);
    expect(isDeepFrozen(first)).toBe(true);
  });

  it("pins the API version into the effective options and the preview", () => {
    const frozen = plugin.freeze(freezeInput());

    expect(LINKEDIN_VERSION).toMatch(/^\d{6}$/);
    expect(frozen.effectiveOptions.linkedinVersion).toBe(LINKEDIN_VERSION);
    expect(frozen.preview.fields).toContainEqual({ name: "linkedinVersion", value: LINKEDIN_VERSION });
    expect(frozen.preview.fields).toContainEqual({ name: "lifecycle_state", value: "PUBLISHED" });
    expect(frozen.preview.fields).toContainEqual({
      name: "author_urn",
      value: `urn:li:person:${LINKEDIN_ACCOUNT.accountId}`,
    });
  });

  it("never reads a clock: now changes nothing in the frozen payload", () => {
    const early = plugin.freeze(freezeInput({ now: "2026-10-08T00:00:00.000Z" }));
    const late = plugin.freeze(freezeInput({ now: "2027-01-02T12:30:00.000Z" }));

    expect(JSON.stringify(early)).toBe(JSON.stringify(late));
  });

  it("sends no distribution value unless the operator supplied one", () => {
    const without = plugin.freeze(freezeInput());
    expect(Object.hasOwn(without.payload, "distribution")).toBe(false);
    expect(without.preview.fields.some((field) => field.name === "distribution")).toBe(false);

    const distribution = { feedDistribution: "MAIN_FEED" };
    const withDistribution = plugin.freeze(freezeInput({ options: postOptions({ distribution }) }));
    expect(withDistribution.payload.distribution).toEqual(distribution);
    expect(withDistribution.effectiveOptions.distribution).toEqual(distribution);
    expect(withDistribution.preview.fields).toContainEqual({ name: "distribution", value: distribution });
  });

  it("preserves shared content verbatim while the commentary comes from the option", () => {
    const frozen = plugin.freeze(freezeInput({ text: "Shared summary." }));

    expect(frozen.effectiveContent).toEqual({ text: "Shared summary." });
    expect(frozen.preview.content).toEqual({ text: "Shared summary." });
    expect(frozen.payload.commentary).toBe("Hello from Syndroo on LinkedIn.");

    // A post-only target may send empty shared content.
    expect(plugin.freeze(freezeInput()).effectiveContent).toEqual({});
  });

  it("exposes every effective option as a preview field", () => {
    const frozen = plugin.freeze(freezeInput());
    const names = frozen.preview.fields.map((field) => field.name);
    for (const key of Object.keys(frozen.effectiveOptions)) {
      expect(names).toContain(key);
    }
  });

  it("rejects a missing or empty commentary and a missing visibility", () => {
    expect(freezeError({ visibility: DEFAULT_VISIBILITY }).code).toBe("commentary_missing");
    expect(freezeError(postOptions({ commentary: "" })).code).toBe("commentary_missing");
    expect(freezeError({ commentary: "text" }).code).toBe("visibility_missing");
    expect(freezeError(postOptions({ visibility: "" })).code).toBe("visibility_missing");
  });

  it("rejects an author selection it does not implement", () => {
    expect(freezeError(postOptions({ author: "organization" })).code).toBe("author_unsupported");
  });

  it("rejects a non-object distribution instead of coercing it", () => {
    expect(freezeError(postOptions({ distribution: "MAIN_FEED" })).code).toBe("distribution_invalid");
    expect(freezeError(postOptions({ distribution: ["MAIN_FEED"] })).code).toBe("distribution_invalid");
  });

  it("rejects a body past the transport-safety ceiling rather than truncating", () => {
    const huge = "a".repeat(1_100_000);
    expect(utf8ByteLength(huge)).toBeGreaterThan(1_000_000);
    const error = freezeError(postOptions({ commentary: huge }));
    expect(error.code).toBe("payload_too_large");
  });
});
