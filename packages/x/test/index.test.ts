import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XPublisher } from "../src/index.js";

const credentials = {
  apiKey: "test-key", apiSecret: "test-secret",
  accessToken: "test-token", accessTokenSecret: "test-token-secret",
};
const request = (content = "Hello") => ({ publicationId: "pub-x", platform: "x" as const, content });
afterEach(() => vi.restoreAllMocks());

describe("X publisher", () => {
  it("uses the SDK to sign and publish a text post once", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { id: "123456789" } }, { status: 201 }));
    await expect(new XPublisher(credentials).publish(request())).resolves.toEqual({
      externalId: "123456789", externalUrl: "https://x.com/i/web/status/123456789",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.x.com/2/tweets");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Hello" });
    const header = new Headers(init?.headers).get("authorization")!;
    const values = Object.fromEntries([...header.matchAll(/(oauth_\w+)="([^"]*)"/g)].map(match => [match[1]!, decodeURIComponent(match[2]!)]));
    const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const signature = values.oauth_signature;
    delete values.oauth_signature;
    const params = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
    const base = `POST&${encode(String(url))}&${encode(params)}`;
    expect(signature).toBe(createHmac("sha1", "test-secret&test-token-secret").update(base).digest("base64"));
  });

  it.each(["", " ", "a".repeat(281), "中".repeat(141)])("rejects invalid text without any request", async text => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(new XPublisher(credentials).publish(request(text))).rejects.toMatchObject({ code: "INVALID_CONTENT", ambiguous: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["a".repeat(280), "中".repeat(140), "👨‍👩‍👧‍👦".repeat(140), "a".repeat(256) + " https://example.com/" + "b".repeat(400)])("accepts text using X weighted counts", async text => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { id: "123" } }, { status: 201 }));
    await expect(new XPublisher(credentials).publish(request(text))).resolves.toHaveProperty("externalId", "123");
  });

  it.each([[400, "INVALID_CONTENT", false], [401, "AUTH", false], [403, "AUTH", false], [429, "RATE_LIMIT", false], [503, "PROVIDER_UNAVAILABLE", true]])("classifies HTTP %s without retrying or exposing response details", async (status, code, ambiguous) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "private-token" }, { status: Number(status) }));
    const result = new XPublisher(credentials).publish(request());
    await expect(result).rejects.toMatchObject({ code, ambiguous, message: `X request failed (HTTP ${status})` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([() => Response.json(null), () => Response.json({ data: {} }), () => new Response("invalid JSON"), () => new Response("x".repeat(65537))])("treats invalid success responses as ambiguous", async response => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    await expect(new XPublisher(credentials).publish(request())).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks connection loss as ambiguous", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("lost connection"));
    await expect(new XPublisher(credentials).publish(request())).rejects.toMatchObject({ code: "NETWORK", ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out while reading the response body without retrying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    })));
    await expect(new XPublisher({ ...credentials, timeoutMs: 10 }).publish(request())).rejects.toMatchObject({ code: "NETWORK", ambiguous: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
