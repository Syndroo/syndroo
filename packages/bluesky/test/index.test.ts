import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishError } from "@syndroo/core";

import { BlueskyPublisher } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BlueskyPublisher", () => {
  it("creates a text record", async () => {
    const responses = [
      Response.json({ accessJwt: "access-token", did: "did:plc:alice" }),
      Response.json({
        cid: "bafy-post",
        uri: "at://did:plc:alice/app.bsky.feed.post/3example",
      }),
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        const response = responses.shift();

        if (!response) {
          throw new Error("Unexpected fetch call");
        }

        return response;
      });

    const publisher = createPublisher();
    const result = await publisher.publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content: "Hello from Syndroo",
    });

    expect(result).toEqual({
      externalId: "bafy-post",
      externalUrl: "https://bsky.app/profile/did%3Aplc%3Aalice/post/3example",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    );
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer access-token");
  });

  it("marks post-stage network failures as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ accessJwt: "access-token", did: "did:plc:alice" }),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = createPublisher().publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content: "Hello from Syndroo",
    });

    await expect(result).rejects.toMatchObject({
      name: "PublishError",
      code: "NETWORK",
      ambiguous: true,
    } satisfies Partial<PublishError>);
  });

  it("rejects oversized content before network access", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = createPublisher().publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content: "a".repeat(301),
    });

    await expect(result).rejects.toMatchObject({
      name: "PublishError",
      code: "INVALID_CONTENT",
      ambiguous: false,
    } satisfies Partial<PublishError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createPublisher(): BlueskyPublisher {
  return new BlueskyPublisher({
    identifier: "alice.bsky.social",
    password: "app-password",
    host: "bsky.social",
  });
}
