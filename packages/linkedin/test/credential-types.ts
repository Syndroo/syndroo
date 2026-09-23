/**
 * Compile-negative credential fixtures (see the threads package for rationale).
 */
import { buildLinkedInPublisher, decodeLinkedInCredential } from "../src/index.js";

decodeLinkedInCredential({
  access_token: "token",
  author: "urn:li:person:Test_123",
  api_version: "202604",
});

// @ts-expect-error - apiVersion is required and has no hidden default
buildLinkedInPublisher({ accessToken: "token", author: "urn:li:person:Test_123" });

// @ts-expect-error - the raw record is not a typed credential
buildLinkedInPublisher({ access_token: "token" });
