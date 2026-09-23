import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  XPublisher,
  buildXPublisher,
  decodeXCredential,
  decodeXUserCredential,
} from "../src/index.js";

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

describe("X transport policy", () => {
  it("asks for manual redirects and refuses a 3xx instead of following it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }),
    );

    await expect(new XPublisher(credentials).publish(request())).rejects.toMatchObject({
      code: "UNKNOWN",
      ambiguous: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("performs exactly one write attempt when the SDK would retry a 503", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: { id: "999" } }, { status: 201 }));

    await expect(new XPublisher(credentials).publish(request())).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      ambiguous: true,
    });
    // The queued success must never be consumed: the SDK retry path stays off.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries a trustworthy Retry-After from an explicit 429 rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({}, { status: 429, headers: { "retry-after": "300" } }),
    );

    const error = await new XPublisher(credentials)
      .publish(request())
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: "RATE_LIMIT", ambiguous: false });
    const delayMs = Date.parse((error as { retryAfterAt?: string }).retryAfterAt ?? "") - Date.now();
    expect(delayMs).toBeGreaterThan(240_000);
    expect(delayMs).toBeLessThanOrEqual(300_500);
  });
});

describe("X typed credential decoding", () => {
  it("separates the direct user credential from the resolved credential", () => {
    expect(
      decodeXUserCredential({ access_token: "user", access_token_secret: "user-secret" }),
    ).toEqual({ accessToken: "user", accessTokenSecret: "user-secret" });

    expect(
      decodeXCredential({
        api_key: "app",
        api_secret: "app-secret",
        access_token: "user",
        access_token_secret: "user-secret",
      }),
    ).toEqual({
      apiKey: "app",
      apiSecret: "app-secret",
      accessToken: "user",
      accessTokenSecret: "user-secret",
    });
  });

  it.each([
    [{}],
    [{ api_key: "app", api_secret: "app-secret" }],
    [{ access_token: "user" }],
    [{ access_token: "user", access_token_secret: "" }],
    [null],
    ["token"],
  ])("rejects %j as a user credential", input => {
    expect(() => decodeXUserCredential(input)).toThrowError(
      expect.objectContaining({ code: "AUTH" }),
    );
  });

  it("rejects a user token pair that is missing the app credentials", () => {
    expect(() =>
      decodeXCredential({ access_token: "user", access_token_secret: "user-secret" }),
    ).toThrowError(expect.objectContaining({ code: "AUTH" }));
  });

  it("builds a publisher without any network activity", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const publisher = buildXPublisher(
      decodeXCredential({
        api_key: "app",
        api_secret: "app-secret",
        access_token: "user",
        access_token_secret: "user-secret",
      }),
    );

    expect(publisher.name).toBe("x-sdk");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow later mutations of the caller's options object", async () => {
    const mutable = {
      apiKey: "app",
      apiSecret: "app-secret",
      accessToken: "original-user",
      accessTokenSecret: "original-user-secret",
    };
    const publisher = new XPublisher(mutable);

    // A caller that reuses and mutates its own object must not be able to swap
    // the account an existing publisher signs with.
    mutable.accessToken = "attacker-user";
    mutable.accessTokenSecret = "attacker-secret";
    mutable.apiKey = "attacker-app";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { id: "123" } }, { status: 201 }));

    await expect(publisher.publish(request())).resolves.toHaveProperty("externalId", "123");

    const header = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization") ?? "";
    expect(decodeURIComponent(header)).not.toContain("attacker");
  });
});
