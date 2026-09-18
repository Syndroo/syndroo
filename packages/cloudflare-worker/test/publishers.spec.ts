/**
 * Provider naming is written to `publications.provider`, so it is stored data
 * rather than a display label. These tests pin the names and prove the stored
 * name still matches the publisher that actually runs. No provider request is
 * made: publisher construction only validates local configuration.
 */
import { describe, expect, it } from "vitest";

import type { Platform } from "@syndroo/core";

import { isPlatformConfigured, providerFor, publisherFor } from "../src/publishers.js";

const configured = {
  BLUESKY_IDENTIFIER: "test.invalid",
  BLUESKY_PASSWORD: "not-a-real-password",
  THREADS_ACCESS_TOKEN: "not-a-real-token",
  X_API_KEY: "test-x-api-key",
  X_API_SECRET: "test-x-api-secret",
  X_ACCESS_TOKEN: "test-x-access-token",
  X_ACCESS_TOKEN_SECRET: "test-x-access-token-secret",
  TUMBLR_CONSUMER_KEY: "test-tumblr-consumer-key",
  TUMBLR_CONSUMER_SECRET: "test-tumblr-consumer-secret",
  TUMBLR_TOKEN: "test-tumblr-token",
  TUMBLR_TOKEN_SECRET: "test-tumblr-token-secret",
  TUMBLR_BLOG: "alice",
  LINKEDIN_ACCESS_TOKEN: "test-linkedin-token",
  LINKEDIN_AUTHOR: "urn:li:person:test-author",
  LINKEDIN_API_VERSION: "202601",
} as unknown as Env;

const expectedProviderNames: [Platform, string][] = [
  ["bluesky", "bluesky-native"],
  ["threads", "threads-native"],
  ["x", "x-sdk"],
  ["tumblr", "tumblr-native"],
  ["linkedin", "linkedin-native"],
];

describe("publisher metadata", () => {
  it.each(expectedProviderNames)(
    "keeps the stored provider name for %s in sync with the constructed publisher",
    (platform, providerName) => {
      expect(providerFor(platform)).toBe(providerName);
      expect(publisherFor(platform, configured).name).toBe(providerName);
    },
  );

  it("treats mastodon and nostr as recognized but not installed", () => {
    for (const platform of ["mastodon", "nostr"] as const) {
      // `publisherFor` checks configuration before the publisher switch, so an
      // uninstalled platform is reported as unconfigured rather than reaching
      // the PROVIDER_UNAVAILABLE branch.
      expect(isPlatformConfigured(platform, configured)).toBe(false);
      expect(() => providerFor(platform)).toThrowError(
        expect.objectContaining({ status: 422, code: "PLATFORM_NOT_CONFIGURED" }),
      );
      expect(() => publisherFor(platform, configured)).toThrowError(
        expect.objectContaining({ code: "AUTH" }),
      );
    }
  });
});
