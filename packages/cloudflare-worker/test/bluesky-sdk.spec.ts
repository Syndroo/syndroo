import { afterEach, expect, it, vi } from "vitest";
import { BlueskyPublisher } from "@syndroo/bluesky";

afterEach(() => vi.restoreAllMocks());

it("publishes through the real Bluesky SDK inside workerd", async () => {
  const cid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({
      accessJwt: "test-access-token",
      refreshJwt: "test-refresh-token",
      handle: "alice.test",
      did: "did:plc:alice",
    }))
    .mockResolvedValueOnce(Response.json({
      cid,
      uri: "at://did:plc:alice/app.bsky.feed.post/test-record",
    }));

  const publisher = new BlueskyPublisher({
    identifier: "alice.test", password: "test-password", host: "bsky.social",
  });
  await expect(publisher.publish({
    publicationId: "sdk-test", platform: "bluesky", content: "SDK runtime test",
  })).resolves.toEqual({
    externalId: cid,
    externalUrl: "https://bsky.app/profile/did%3Aplc%3Aalice/post/test-record",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
