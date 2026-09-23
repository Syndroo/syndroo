/**
 * Native workerd evidence for the transport and the five migrated providers.
 *
 * Every request below leaves the worker through workerd's real fetch path and is
 * answered by the `outboundService` fixture (see `outbound-fixture.ts`), which
 * throws for any destination it does not list. Nothing here replaces
 * `globalThis.fetch` and nothing here reaches the internet.
 *
 * These fixtures cover the transport's own positive and negative behaviour. The
 * production-bundle end-to-end chain (NET-01) is still the integration task's.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { BlueskyPublisher } from "@syndroo/bluesky";
import { LinkedInPublisher } from "@syndroo/linkedin";
import { ThreadsPublisher } from "@syndroo/threads";
import { TumblrPublisher } from "@syndroo/tumblr";
import { XPublisher } from "@syndroo/x";

import {
  TransportError,
  boundedRequest,
  oauth1Signature,
  type TransportRequest,
} from "../src/index.ts";
import type { OutboundStats } from "./outbound-fixture.ts";

function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: "https://provider.example/ok",
    method: "POST",
    body: "payload",
    ...overrides,
  };
}

async function stats(): Promise<OutboundStats> {
  const response = await fetch("https://stats.invalid/_stats");
  return (await response.json()) as OutboundStats;
}

beforeEach(async () => {
  await fetch("https://stats.invalid/_reset");
});

describe("native outbound fixture", () => {
  it("returns a real bounded response", async () => {
    const response = await boundedRequest(request());

    expect(response.status).toBe(200);
    expect(response.text()).toBe('{"ok":true}');
    expect((await stats()).providerHits["provider.example"]).toBe(1);
  });

  it("fails closed for an unlisted destination", async () => {
    // Miniflare turns a thrown handler error into a 500 for the caller; the
    // important part is that the request never leaves the fixture.
    const response = await boundedRequest(
      request({ url: "https://unlisted.invalid/exfiltrate" }),
    ).catch(() => undefined);

    expect(response?.status).toBe(500);
    expect((await stats()).unexpected).toBe(1);
  });
});

describe("native redirect refusal", () => {
  it.each([301, 302, 303, 307, 308])(
    "does not follow HTTP %i and never touches the second hop",
    async status => {
      const failure = await boundedRequest(
        request({ url: `https://provider.example/redirect/${status}` }),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TransportError);
      expect((failure as TransportError).code).toBe("redirect");
      expect((failure as TransportError).requestDispatched).toBe(true);

      const observed = await stats();
      expect(observed.secondHop).toBe(0);
      expect(observed.secondHopWithAuthOrBody).toBe(0);
    },
  );
});

describe("native bound enforcement", () => {
  it("stops an oversized native body", async () => {
    const failure = await boundedRequest(
      request({ url: "https://provider.example/overflow" }),
    ).catch((error: unknown) => error);

    expect((failure as TransportError).code).toBe("response_too_large");
  });

  it("ends a slow native stream within the deadline", async () => {
    const startedAt = Date.now();
    const failure = await boundedRequest(
      request({ url: "https://provider.example/slow", timeoutMs: 300 }),
    ).catch((error: unknown) => error);
    const elapsed = Date.now() - startedAt;

    expect((failure as TransportError).code).toBe("timeout");
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("native provider round trips", () => {
  const publication = { publicationId: "pub-native", content: "Hello from Syndroo" };

  it("publishes through all five providers over workerd's own fetch", async () => {
    await expect(
      new ThreadsPublisher({ accessToken: "native-token" }).publish({
        ...publication,
        platform: "threads",
      }),
    ).resolves.toEqual({ externalId: "threads-native-1" });

    await expect(
      new LinkedInPublisher({
        accessToken: "native-token",
        author: "urn:li:person:Test_123",
        apiVersion: "202604",
      }).publish({ ...publication, platform: "linkedin" }),
    ).resolves.toMatchObject({ externalId: "urn:li:share:123456789123456789" });

    await expect(
      new TumblrPublisher({
        consumerKey: "native-key",
        consumerSecret: "native-secret",
        token: "native-token",
        tokenSecret: "native-token-secret",
        blog: "example",
      }).publish({ ...publication, platform: "tumblr" }),
    ).resolves.toMatchObject({ externalId: "123456789123456789" });

    await expect(
      new XPublisher({
        apiKey: "native-key",
        apiSecret: "native-secret",
        accessToken: "native-token",
        accessTokenSecret: "native-token-secret",
      }).publish({ ...publication, platform: "x" }),
    ).resolves.toMatchObject({ externalId: "123456789" });

    await expect(
      new BlueskyPublisher({
        identifier: "alice.test",
        password: "native-password",
        host: "bsky.social",
      }).publish({ ...publication, platform: "bluesky" }),
    ).resolves.toMatchObject({
      externalId: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    });

    const observed = await stats();

    for (const host of [
      "graph.threads.net",
      "api.linkedin.com",
      "api.tumblr.com",
      "api.x.com",
      "bsky.social",
    ]) {
      expect(observed.providerHits[host] ?? 0).toBeGreaterThan(0);
    }

    expect(observed.unexpected).toBe(0);
  });

  it("signs the published RFC 5849 vector with workerd WebCrypto", async () => {
    const signature = await oauth1Signature({
      method: "POST",
      url: "http://example.com/request",
      parameters: [
        ["b5", "=%3D"],
        ["a3", "a"],
        ["c@", ""],
        ["a2", "r b"],
        ["a3", "2 q"],
        ["c2", ""],
      ],
      consumerKey: "9djdj82h48djs9d2",
      consumerSecret: "j49sk3j29djd",
      token: "kkk9d7dh3k39sjv7",
      tokenSecret: "dh893hdasih9",
      nonce: "7d8f3e4a",
      timestamp: "137131201",
    });

    expect(signature).toBe("r6/TJjbCOr97/+UU0NsvSne7s5g=");
  });
});
