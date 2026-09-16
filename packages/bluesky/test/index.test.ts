import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishError } from "@syndroo/core";

import { BlueskyPublisher } from "../src/index.js";

const cid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BlueskyPublisher", () => {
  it("creates a text record", async () => {
    const responses = [
      sessionResponse(),
      Response.json({
        cid,
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
      externalId: cid,
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
        sessionResponse(),
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

  it("adds clickable URL facets with UTF-8 byte offsets", async () => {
    const responses = [
      sessionResponse(),
      Response.json({
        cid,
        uri: "at://did:plc:alice/app.bsky.feed.post/3example",
      }),
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => responses.shift() ?? Response.error());
    const content = "中文 https://grant-dai.com/posts/example";

    await createPublisher().publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content,
    });

    const body = await new Response(fetchMock.mock.calls[1]?.[1]?.body).json() as {
      record: Record<string, unknown>;
    };
    const byteStart = new TextEncoder().encode("中文 ").byteLength;
    const uri = "https://grant-dai.com/posts/example";
    expect(body.record.facets).toEqual([
      {
        index: {
          byteStart,
          byteEnd: byteStart + new TextEncoder().encode(uri).byteLength,
        },
        features: [
          {
            $type: "app.bsky.richtext.facet#link",
            uri,
          },
        ],
      },
    ]);
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

  it.each([
    [401, "AUTH", false],
    [429, "RATE_LIMIT", false],
    [400, "INVALID_CONTENT", false],
    [503, "PROVIDER_UNAVAILABLE", true],
  ])("does not retry publish HTTP %s", async (status, code, ambiguous) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json({ error: "Rejected", message: "secret-must-not-escape" }, { status }));
    const result = createPublisher().publish({ publicationId: "pub-1", platform: "bluesky", content: "Hello" });
    await expect(result).rejects.toMatchObject({ code, ambiguous });
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining("secret-must-not-escape"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps session failures unambiguous", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failed"));
    await expect(createPublisher().publish({ publicationId: "pub-1", platform: "bluesky", content: "Hello" }))
      .rejects.toMatchObject({ code: "NETWORK", ambiguous: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => Response.json({ cid: "invalid", uri: "invalid" }),
    () => new Response("not JSON"),
    () => new Response("x".repeat(65 * 1024)),
  ])("marks invalid publish responses as ambiguous without retrying", async response => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(response());
    await expect(createPublisher().publish({ publicationId: "pub-1", platform: "bluesky", content: "Hello" }))
      .rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // workerd rejects `redirect: "error"` before the request is dispatched, so
  // the transport must ask for "manual" and treat a 3xx as a failure itself.
  it("requests manual redirect handling in both stages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json({
        cid,
        uri: "at://did:plc:alice/app.bsky.feed.post/3example",
      }));

    await createPublisher().publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content: "Hello from Syndroo",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });

  it("does not follow a session redirect", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      redirectResponse(),
    );

    await expect(createPublisher().publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content: "Hello from Syndroo",
    })).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a publish redirect", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(redirectResponse());

    await expect(createPublisher().publish({
      publicationId: "pub-1",
      platform: "bluesky",
      content: "Hello from Syndroo",
    })).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });
});

function redirectResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "https://attacker.example/collect" },
  });
}

function createPublisher(): BlueskyPublisher {
  return new BlueskyPublisher({
    identifier: "alice.bsky.social",
    password: "app-password",
    host: "bsky.social",
  });
}

function sessionResponse(): Response {
  return Response.json({
    accessJwt: "access-token",
    refreshJwt: "refresh-token",
    handle: "alice.bsky.social",
    did: "did:plc:alice",
  });
}
