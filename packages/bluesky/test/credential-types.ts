/**
 * Compile-negative credential fixtures (see the threads package for rationale).
 */
import { buildBlueskyPublisher, decodeBlueskyCredential } from "../src/index.js";

decodeBlueskyCredential({ identifier: "alice.test", password: "pw", host: "bsky.social" });

// @ts-expect-error - the host is required on the typed credential
buildBlueskyPublisher({ identifier: "alice.test", password: "pw" });
