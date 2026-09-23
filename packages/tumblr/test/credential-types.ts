/**
 * Compile-negative credential fixtures (see the threads package for rationale).
 */
import {
  buildTumblrPublisher,
  decodeTumblrCredential,
  decodeTumblrUserCredential,
} from "../src/index.js";

decodeTumblrUserCredential({ token: "token", token_secret: "secret" });
decodeTumblrCredential({
  consumer_key: "key",
  consumer_secret: "secret",
  token: "token",
  token_secret: "token-secret",
  blog: "example",
});

// @ts-expect-error - the resolved credential requires a blog
buildTumblrPublisher({
  consumerKey: "key",
  consumerSecret: "secret",
  token: "token",
  tokenSecret: "token-secret",
});

// @ts-expect-error - a user credential is missing the app credentials
buildTumblrPublisher({ token: "token", tokenSecret: "token-secret", blog: "example" });
