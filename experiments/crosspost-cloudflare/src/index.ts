import { BlueskyStrategy } from "@humanwhocodes/crosspost";

export default {
  fetch(): Response {
    const strategy = new BlueskyStrategy({
      identifier: "compatibility-spike.invalid",
      password: "not-used",
      host: "bsky.social",
    });

    return Response.json({
      status: "ok",
      provider: "crosspost",
      platform: "bluesky",
      strategy: strategy.constructor.name,
    });
  },
} satisfies ExportedHandler<Env>;
