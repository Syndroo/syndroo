import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishError } from "@syndroo/core";

import { ThreadsPublisher } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThreadsPublisher", () => {
  it("creates and immediately publishes a text post", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "threads-post-1" }));

    const result = await createPublisher().publish({
      publicationId: "pub-1",
      platform: "threads",
      content: "Hello from Syndroo",
    });

    expect(result).toEqual({ externalId: "threads-post-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://graph.threads.net/me/threads",
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer threads-token",
    );
    expect(String(init?.body)).toBe(
      "media_type=TEXT&text=Hello+from+Syndroo&auto_publish_text=true",
    );
  });

  it("maps authentication errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: { message: "Invalid OAuth access token" } },
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    const result = createPublisher().publish({
      publicationId: "pub-1",
      platform: "threads",
      content: "Hello from Syndroo",
    });

    await expect(result).rejects.toMatchObject({
      name: "PublishError",
      code: "AUTH",
      ambiguous: false,
    } satisfies Partial<PublishError>);
  });

  it("marks network failures as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    const result = createPublisher().publish({
      publicationId: "pub-1",
      platform: "threads",
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
      platform: "threads",
      content: "a".repeat(501),
    });

    await expect(result).rejects.toMatchObject({
      name: "PublishError",
      code: "INVALID_CONTENT",
      ambiguous: false,
    } satisfies Partial<PublishError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createPublisher(): ThreadsPublisher {
  return new ThreadsPublisher({ accessToken: "threads-token" });
}
