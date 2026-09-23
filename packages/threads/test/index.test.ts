import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishError } from "@syndroo/core";

import {
  ThreadsPublisher,
  buildThreadsPublisher,
  decodeThreadsCredential,
} from "../src/index.js";

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

describe("Threads transport policy", () => {
  it("asks for manual redirects and refuses a 3xx instead of following it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      }),
    );

    await expect(
      createPublisher().publish({
        publicationId: "pub-1",
        platform: "threads",
        content: "Redirect me",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("carries a trustworthy Retry-After from an explicit 429 rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    );

    const error = await createPublisher()
      .publish({ publicationId: "pub-1", platform: "threads", content: "Hi" })
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: "RATE_LIMIT", ambiguous: false });
    const retryAfterAt = (error as { retryAfterAt?: string }).retryAfterAt;
    expect(typeof retryAfterAt).toBe("string");
    const delayMs = Date.parse(retryAfterAt ?? "") - Date.now();
    expect(delayMs).toBeGreaterThan(60_000);
    expect(delayMs).toBeLessThanOrEqual(120_500);
    // No provider message or raw response text is attached.
    expect((error as Error).message).not.toContain("rate limited");
  });

  it("ignores a malformed or already elapsed Retry-After", async () => {
    for (const header of ["not-a-date", "-5", "0"]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": header } }),
      );

      const error = await createPublisher()
        .publish({ publicationId: "pub-1", platform: "threads", content: "Hi" })
        .catch((failure: unknown) => failure);

      expect((error as { retryAfterAt?: string }).retryAfterAt).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it("bounds a provider that never answers", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const startedAt = Date.now();

    await expect(
      new ThreadsPublisher({ accessToken: "threads-token", timeoutMs: 40 }).publish({
        publicationId: "pub-1",
        platform: "threads",
        content: "Stalled",
      }),
    ).rejects.toMatchObject({ code: "NETWORK", ambiguous: true });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("refuses an oversized provider response without trusting it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(70 * 1024), {
        status: 200,
        headers: { "content-length": String(70 * 1024) },
      }),
    );

    await expect(
      createPublisher().publish({
        publicationId: "pub-1",
        platform: "threads",
        content: "Big response",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
  });
});

describe("Threads typed credential decoding", () => {
  it("decodes a complete credential record", () => {
    expect(decodeThreadsCredential({ access_token: "  token-value  " })).toEqual({
      accessToken: "token-value",
    });
  });

  it.each([
    [{}],
    [{ access_token: "" }],
    [{ access_token: "   " }],
    [{ access_token: 42 }],
    [{ accessToken: "camel-case-is-not-the-contract" }],
    [null],
    ["token"],
    [[]],
  ])("rejects %j without borrowing credentials from elsewhere", input => {
    expect(() => decodeThreadsCredential(input)).toThrowError(
      expect.objectContaining({ code: "AUTH" }),
    );
  });

  it("builds a publisher without any network activity", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const publisher = buildThreadsPublisher(decodeThreadsCredential({
      access_token: "token-value",
    }));

    expect(publisher.name).toBe("threads-native");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
