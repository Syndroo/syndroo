import { BlueskyPublisher } from "@syndroo/bluesky";
import { ThreadsPublisher } from "@syndroo/threads";
import {
  PublishError,
  type Platform,
  type Publisher,
} from "@syndroo/core";

export function publisherFor(platform: Platform, env: Env): Publisher {
  switch (platform) {
    case "bluesky":
      return new BlueskyPublisher({
        identifier: env.BLUESKY_IDENTIFIER,
        password: env.BLUESKY_PASSWORD,
        host: env.BLUESKY_HOST,
      });
    case "threads":
      return new ThreadsPublisher({
        accessToken: env.THREADS_ACCESS_TOKEN,
      });
    case "x":
    case "mastodon":
    case "linkedin":
    case "nostr":
      throw new PublishError(
        "No publisher configured for platform: " + platform,
        "PROVIDER_UNAVAILABLE",
      );
  }
}
