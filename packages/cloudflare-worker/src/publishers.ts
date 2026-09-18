import { BlueskyPublisher } from "@syndroo/bluesky";
import { ThreadsPublisher } from "@syndroo/threads";
import { XPublisher } from "@syndroo/x";
import { TumblrPublisher, normalizeTumblrBlog } from "@syndroo/tumblr";
import { LinkedInPublisher, isLinkedInConfigurationValid } from "@syndroo/linkedin";
import {
  PublishError,
  type Platform,
  type Publisher,
} from "@syndroo/core";

import { ApiError } from "./http.js";

export function isPlatformConfigured(platform: Platform, env: Env): boolean {
  switch (platform) {
    case "linkedin":
      return isLinkedInConfigurationValid(env.LINKEDIN_ACCESS_TOKEN, env.LINKEDIN_AUTHOR, env.LINKEDIN_API_VERSION);
    case "tumblr":
      if (![env.TUMBLR_CONSUMER_KEY, env.TUMBLR_CONSUMER_SECRET, env.TUMBLR_TOKEN, env.TUMBLR_TOKEN_SECRET, env.TUMBLR_BLOG]
        .every(value => Boolean(value?.trim()))) return false;
      try { normalizeTumblrBlog(env.TUMBLR_BLOG!); return true; }
      catch { return false; }
    case "bluesky":
      return Boolean(env.BLUESKY_IDENTIFIER?.trim() && env.BLUESKY_PASSWORD?.trim());
    case "threads":
      return Boolean(env.THREADS_ACCESS_TOKEN?.trim());
    case "x":
      return [env.X_API_KEY, env.X_API_SECRET, env.X_ACCESS_TOKEN, env.X_ACCESS_TOKEN_SECRET]
        .every(value => Boolean(value?.trim()));
    default:
      return false;
  }
}

export function publisherFor(platform: Platform, env: Env): Publisher {
  if (!isPlatformConfigured(platform, env)) {
    throw new PublishError("Platform credentials are not configured: " + platform, "AUTH");
  }
  switch (platform) {
    case "linkedin":
      return new LinkedInPublisher({ accessToken: env.LINKEDIN_ACCESS_TOKEN!,
        author: env.LINKEDIN_AUTHOR!, apiVersion: env.LINKEDIN_API_VERSION! });
    case "tumblr":
      return new TumblrPublisher({
        consumerKey: env.TUMBLR_CONSUMER_KEY!, consumerSecret: env.TUMBLR_CONSUMER_SECRET!,
        token: env.TUMBLR_TOKEN!, tokenSecret: env.TUMBLR_TOKEN_SECRET!, blog: env.TUMBLR_BLOG!,
      });
    case "bluesky":
      return new BlueskyPublisher({
        identifier: env.BLUESKY_IDENTIFIER!,
        password: env.BLUESKY_PASSWORD!,
        host: env.BLUESKY_HOST?.trim() || "bsky.social",
      });
    case "threads":
      return new ThreadsPublisher({
        accessToken: env.THREADS_ACCESS_TOKEN!,
      });
    case "x":
      return new XPublisher({
        apiKey: env.X_API_KEY!, apiSecret: env.X_API_SECRET!,
        accessToken: env.X_ACCESS_TOKEN!, accessTokenSecret: env.X_ACCESS_TOKEN_SECRET!,
      });
    case "mastodon":
    case "nostr":
      throw new PublishError(
        "No publisher configured for platform: " + platform,
        "PROVIDER_UNAVAILABLE",
      );
  }
}

/**
 * Stored provider identifier for a platform. The value is written to
 * `publications.provider`, so these strings are part of the stored-data
 * contract and must not change silently.
 *
 * Provider naming and publisher construction stay separate switches on
 * purpose: naming never depends on credentials, while construction validates
 * them. Installed-platform configuration, publisher construction, and provider
 * naming are maintained in this one file; the switches remain distinct.
 */
export function providerFor(platform: Platform): string {
  switch (platform) {
    case "bluesky":
      return "bluesky-native";
    case "threads":
      return "threads-native";
    case "x":
      return "x-sdk";
    case "tumblr":
      return "tumblr-native";
    case "linkedin":
      return "linkedin-native";
    case "mastodon":
    case "nostr":
      throw new ApiError(
        "Platform is not configured yet: " + platform,
        422,
        "PLATFORM_NOT_CONFIGURED",
      );
  }
}
