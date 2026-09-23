import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TumblrPublisher,
  buildTumblrPublisher,
  decodeTumblrCredential,
  decodeTumblrUserCredential,
  normalizeTumblrBlog,
} from "../src/index.js";

const options = { consumerKey: "test key!", consumerSecret: "test&secret", token: "test/token", tokenSecret: "test secret", blog: "Example.tumblr.com" };
const request = (content = "Hello <b>plain</b> 中文 👋\nNext") => ({ publicationId: "pub", platform: "tumblr" as const, content });
const success = () => Response.json({ meta: { status: 201 }, response: { id: "123456789123456789" } }, { status: 201 });
afterEach(() => vi.restoreAllMocks());

it("signs JSON POST with correct OAuth encoding and no secondary cross-posting", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(success());
  await expect(new TumblrPublisher(options).publish(request())).resolves.toEqual({
    externalId: "123456789123456789", externalUrl: "https://example.tumblr.com/post/123456789123456789",
  });
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0]!;
  expect(url).toBe("https://api.tumblr.com/v2/blog/example.tumblr.com/posts");
  // The shared transport always asks for manual redirects and rejects 3xx
  // itself; workerd refuses `redirect: "error"` before dispatch.
  expect(init?.redirect).toBe("manual");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ state: "published", send_to_twitter: false, content: [{ type: "text", text: request().content }] });
  const header = new Headers(init?.headers).get("authorization")!;
  const values = Object.fromEntries([...header.matchAll(/(oauth_\w+)="([^"]*)"/g)].map(match => [match[1]!, decodeURIComponent(match[2]!)]));
  const signature = values.oauth_signature;
  delete values.oauth_signature;
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const normalized = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
  expect(signature).toBe(createHmac("sha1", "test%26secret&test%20secret").update(`POST&${encode(String(url))}&${encode(normalized)}`).digest("base64"));
  expect(values.oauth_consumer_key).toBe(options.consumerKey);
  expect(values.oauth_token).toBe(options.token);
});

it.each(["", " ", "a".repeat(4097)])("rejects invalid text before network", async content => {
  const mock = vi.spyOn(globalThis, "fetch");
  await expect(new TumblrPublisher(options).publish(request(content))).rejects.toMatchObject({ code: "INVALID_CONTENT", ambiguous: false });
  expect(mock).not.toHaveBeenCalled();
});
it("counts Unicode code points rather than UTF-16 units", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(success());
  await expect(new TumblrPublisher(options).publish(request("👋".repeat(4096)))).resolves.toHaveProperty("externalId");
});
it.each(["https://example.tumblr.com", "../other", "example.com", "alice/../../user", ""]) ("rejects unsafe blog configuration", blog => {
  expect(() => normalizeTumblrBlog(blog)).toThrow(TypeError);
});
it.each([[401, "AUTH", false], [403, "AUTH", false], [404, "AUTH", false], [429, "RATE_LIMIT", false], [400, "INVALID_CONTENT", false], [503, "PROVIDER_UNAVAILABLE", true]])("classifies HTTP %s without leaking details or retrying", async (status, code, ambiguous) => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-token", { status: Number(status) }));
  await expect(new TumblrPublisher(options).publish(request())).rejects.toMatchObject({ code, ambiguous, message: `Tumblr request failed (HTTP ${status})` });
  expect(mock).toHaveBeenCalledTimes(1);
});
it.each([null, {}, { meta: { status: 201 }, response: { id: 123 } }, { meta: { status: 500 }, response: { id: "123" } }])("treats unconfirmed success as ambiguous", async body => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status: 201 }));
  await expect(new TumblrPublisher(options).publish(request())).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
});
it.each(["not json", "x".repeat(65_537)])("rejects invalid or oversized responses", async body => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 201 }));
  await expect(new TumblrPublisher(options).publish(request())).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
});
it("cancels a stalled response body at the deadline", async () => {
  const cancel = vi.fn();
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 201 }));
  await expect(new TumblrPublisher({ ...options, timeoutMs: 10 }).publish(request())).rejects.toMatchObject({ code: "NETWORK", ambiguous: true });
  expect(cancel).toHaveBeenCalled();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it("classifies a lost connection as ambiguous", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private token"));
  await expect(new TumblrPublisher(options).publish(request())).rejects.toMatchObject({ code: "NETWORK", ambiguous: true, message: "Tumblr request or response was interrupted" });
  expect(mock).toHaveBeenCalledTimes(1);
});

it("refuses a redirect instead of following it to another origin", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }),
  );

  await expect(new TumblrPublisher(options).publish(request())).rejects.toMatchObject({
    code: "UNKNOWN",
    ambiguous: true,
  });
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]?.[1]?.redirect).toBe("manual");
});

it("carries a trustworthy Retry-After from an explicit 429 rejection", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("private-token", { status: 429, headers: { "retry-after": "900" } }),
  );

  const error = await new TumblrPublisher(options)
    .publish(request())
    .catch((failure: unknown) => failure);

  expect(error).toMatchObject({
    code: "RATE_LIMIT",
    ambiguous: false,
    message: "Tumblr request failed (HTTP 429)",
  });
  const delayMs = Date.parse((error as { retryAfterAt?: string }).retryAfterAt ?? "") - Date.now();
  expect(delayMs).toBeGreaterThan(840_000);
  expect(delayMs).toBeLessThanOrEqual(900_500);
});

describe("Tumblr typed credential decoding", () => {
  it("decodes the direct user credential without app secrets", () => {
    expect(
      decodeTumblrUserCredential({ token: "user", token_secret: "user-secret" }),
    ).toEqual({ token: "user", tokenSecret: "user-secret" });
  });

  it("requires app credentials and a blog for the resolved credential", () => {
    expect(
      decodeTumblrCredential({
        consumer_key: "app",
        consumer_secret: "app-secret",
        token: "user",
        token_secret: "user-secret",
        blog: "example",
      }),
    ).toEqual({
      consumerKey: "app",
      consumerSecret: "app-secret",
      token: "user",
      tokenSecret: "user-secret",
      blog: "example",
    });
  });

  it.each([
    [{}],
    [{ token: "user" }],
    [{ token_secret: "user-secret" }],
    [{ consumer_key: "app", consumer_secret: "app-secret" }],
    [null],
  ])("rejects %j without borrowing missing pieces from elsewhere", input => {
    expect(() => decodeTumblrUserCredential(input)).toThrowError(
      expect.objectContaining({ code: "AUTH" }),
    );
  });

  it("rejects a resolved credential that lacks app credentials or a blog", () => {
    for (const input of [
      { token: "user", token_secret: "user-secret", blog: "example" },
      {
        consumer_key: "app",
        consumer_secret: "app-secret",
        token: "user",
        token_secret: "user-secret",
      },
    ]) {
      expect(() => decodeTumblrCredential(input)).toThrowError(
        expect.objectContaining({ code: "AUTH" }),
      );
    }
  });

  it("builds a publisher without any network activity", () => {
    const mock = vi.spyOn(globalThis, "fetch");

    const publisher = buildTumblrPublisher(
      decodeTumblrCredential({
        consumer_key: "app",
        consumer_secret: "app-secret",
        token: "user",
        token_secret: "user-secret",
        blog: "example",
      }),
    );

    expect(publisher.name).toBe("tumblr-native");
    expect(mock).not.toHaveBeenCalled();
  });
});
