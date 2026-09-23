import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LinkedInPublisher,
  buildLinkedInPublisher,
  decodeLinkedInCredential,
  isLinkedInConfigurationValid,
} from "../src/index.js";

const options = { accessToken: "test-token", author: "urn:li:person:Test_123", apiVersion: "202604" };
const request = (content = "Hello") => ({ publicationId: "pub", platform: "linkedin" as const, content });
const success = (id = "urn:li:share:123456789123456789") => new Response(null, { status: 201, headers: { "x-restli-id": id } });
afterEach(() => vi.restoreAllMocks());

it.each(["urn:li:person:Test_123", "urn:li:organization:123"])("publishes as %s with explicit version and distribution", async author => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(success());
  await expect(new LinkedInPublisher({ ...options, author }).publish(request())).resolves.toEqual({
    externalId: "urn:li:share:123456789123456789",
    externalUrl: "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123456789123456789/",
  });
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0]!;
  expect(url).toBe("https://api.linkedin.com/rest/posts");
  expect(init?.method).toBe("POST");
  // The shared transport always asks for manual redirects and rejects 3xx
  // itself; workerd refuses `redirect: "error"` before dispatch.
  expect(init?.redirect).toBe("manual");
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBe("Bearer test-token");
  expect(headers.get("linkedin-version")).toBe("202604");
  expect(headers.get("x-restli-protocol-version")).toBe("2.0.0");
  expect(JSON.parse(String(init?.body))).toEqual({ author, commentary: "Hello", visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false });
});
it("escapes every little-text reserved character without losing newlines or Unicode", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(success());
  await new LinkedInPublisher(options).publish(request("|{}@[]()<>#\\*_~\n中文 👋"));
  expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body)).commentary)
    .toBe("\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~\n中文 👋");
});
it.each(["", " ", "a".repeat(3001), "*".repeat(1501), "a\u0000b"])("rejects invalid text before network", async content => {
  const mock = vi.spyOn(globalThis, "fetch");
  await expect(new LinkedInPublisher(options).publish(request(content))).rejects.toMatchObject({ code: "INVALID_CONTENT", ambiguous: false });
  expect(mock).not.toHaveBeenCalled();
});
it.each(["a".repeat(3000), "👋".repeat(1500), "*".repeat(1500)])("accepts the conservative serialized length boundary", async content => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(success());
  await expect(new LinkedInPublisher(options).publish(request(content))).resolves.toHaveProperty("externalId");
});
it.each([
  { accessToken: "" }, { accessToken: "bad\r\nheader" }, { author: "https://linkedin.com/in/me" },
  { author: "urn:li:organization:abc" }, { apiVersion: "202613" }, { apiVersion: "" },
])("rejects invalid configuration", override => {
  const settings = { ...options, ...override };
  expect(isLinkedInConfigurationValid(settings.accessToken, settings.author, settings.apiVersion)).toBe(false);
  expect(() => new LinkedInPublisher(settings)).toThrow(TypeError);
});
it.each([[400, "INVALID_CONTENT", false], [401, "AUTH", false], [403, "AUTH", false], [429, "RATE_LIMIT", false],
  [503, "PROVIDER_UNAVAILABLE", true], [409, "UNKNOWN", true], [426, "UNKNOWN", true]])("classifies HTTP %s without retry or secret leakage", async (status, code, ambiguous) => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-token", { status: Number(status) }));
  await expect(new LinkedInPublisher(options).publish(request())).rejects.toMatchObject({ code, ambiguous, message: `LinkedIn request failed (HTTP ${status})` });
  expect(mock).toHaveBeenCalledTimes(1);
});
it.each(["urn:li:ugcPost:123", "urn%3Ali%3Ashare%3A123"])("handles post ID %s", async id => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(success(id));
  await expect(new LinkedInPublisher(options).publish(request())).resolves.toHaveProperty("externalId", decodeURIComponent(id));
});
it.each(["", "123", "https://evil.example", "%bad%", "x".repeat(257)])("marks invalid confirmation as ambiguous", async id => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(success(id));
  await expect(new LinkedInPublisher(options).publish(request())).rejects.toMatchObject({ code: "UNKNOWN", ambiguous: true });
});
it("does not read or wait for a stalled body after confirmed creation", async () => {
  const cancel = vi.fn();
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel }), {
    status: 201, headers: { "x-restli-id": "urn:li:share:123", "content-length": "100000000" },
  }));
  await expect(new LinkedInPublisher(options).publish(request())).resolves.toHaveProperty("externalId");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it("aborts a request that never returns headers, without retrying", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  await expect(new LinkedInPublisher({ ...options, timeoutMs: 10 }).publish(request())).rejects.toMatchObject({ code: "NETWORK", ambiguous: true });
  expect(mock).toHaveBeenCalledTimes(1);
});
it("does not expose network error details", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private-token"));
  await expect(new LinkedInPublisher(options).publish(request())).rejects.toMatchObject({ code: "NETWORK", ambiguous: true, message: "LinkedIn request was interrupted" });
});

it("refuses a redirect instead of forwarding the bearer token", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }),
  );

  await expect(new LinkedInPublisher(options).publish(request())).rejects.toMatchObject({
    code: "UNKNOWN",
    ambiguous: true,
  });
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]?.[1]?.redirect).toBe("manual");
});

it("carries a trustworthy Retry-After from an explicit 429 rejection", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("private-token", { status: 429, headers: { "retry-after": "1800" } }),
  );

  const error = await new LinkedInPublisher(options)
    .publish(request())
    .catch((failure: unknown) => failure);

  expect(error).toMatchObject({
    code: "RATE_LIMIT",
    ambiguous: false,
    message: "LinkedIn request failed (HTTP 429)",
  });
  const delayMs = Date.parse((error as { retryAfterAt?: string }).retryAfterAt ?? "") - Date.now();
  expect(delayMs).toBeGreaterThan(1_740_000);
  expect(delayMs).toBeLessThanOrEqual(1_800_500);
});

describe("LinkedIn typed credential decoding", () => {
  it("decodes a complete credential", () => {
    expect(
      decodeLinkedInCredential({
        access_token: "token",
        author: "urn:li:person:Test_123",
        api_version: "202604",
      }),
    ).toEqual({
      accessToken: "token",
      author: "urn:li:person:Test_123",
      apiVersion: "202604",
    });
  });

  it.each([
    [{}],
    [{ access_token: "token", author: "urn:li:person:Test_123" }],
    [{ access_token: "token", api_version: "202604" }],
    [{ author: "urn:li:person:Test_123", api_version: "202604" }],
    [{ access_token: "token", author: "urn:li:person:Test_123", api_version: "202613" }],
    [{ client_id: "app", client_secret: "app-secret" }],
    [null],
  ])("rejects %j without inventing an API version", input => {
    expect(() => decodeLinkedInCredential(input)).toThrowError(
      expect.objectContaining({ code: "AUTH" }),
    );
  });

  it("builds a publisher without any network activity", () => {
    const mock = vi.spyOn(globalThis, "fetch");

    const publisher = buildLinkedInPublisher(
      decodeLinkedInCredential({
        access_token: "token",
        author: "urn:li:person:Test_123",
        api_version: "202604",
      }),
    );

    expect(publisher.name).toBe("linkedin-native");
    expect(mock).not.toHaveBeenCalled();
  });
});
