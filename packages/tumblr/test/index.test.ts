import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { TumblrPublisher, normalizeTumblrBlog } from "../src/index.js";

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
  expect(init?.redirect).toBe("error");
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
