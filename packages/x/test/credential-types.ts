/**
 * Compile-negative credential fixtures (see the threads package for rationale).
 */
import {
  buildXPublisher,
  decodeXCredential,
  decodeXUserCredential,
} from "../src/index.js";

decodeXUserCredential({ access_token: "token", access_token_secret: "secret" });
decodeXCredential({
  api_key: "key",
  api_secret: "secret",
  access_token: "token",
  access_token_secret: "token-secret",
});

// @ts-expect-error - the resolved credential also needs the app keys
buildXPublisher({ accessToken: "token", accessTokenSecret: "secret" });

// @ts-expect-error - a user credential is not assignable to the resolved credential
buildXPublisher(decodeXUserCredential({ access_token: "t", access_token_secret: "s" }));
