import { afterEach, describe, expect, it } from "vitest";

import {
  SyndrooApiError,
  SyndrooClient,
  SyndrooConfigError,
  SyndrooValidationError,
} from "../src/index.js";
import {
  headerOf,
  jsonResponse,
  redirectResponse,
  requestAt,
  startFixtureServer,
  type FixtureServer,
} from "./support/loopback.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const servers: FixtureServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();

    if (server !== undefined) {
      await server.close();
    }
  }
});

async function fixture(
  ...args: Parameters<typeof startFixtureServer>
): Promise<FixtureServer> {
  const server = await startFixtureServer(...args);
  servers.push(server);
  return server;
}

describe("redirect handling", () => {
  for (const status of [302, 307, 308]) {
    it(`refuses HTTP ${status} and never forwards the Authorization header`, async () => {
      const target = await fixture((_request, response) => {
        jsonResponse(response, 202, { id: "post_hijacked", status: "queued" });
      });
      const origin = await fixture((_request, response) => {
        redirectResponse(response, status, `${target.url}/v1/posts`);
      });
      const syndroo = new SyndrooClient({ baseUrl: origin.url, apiKey: API_KEY });

      const error = await captured(
        syndroo.posts.create(
          { content: "Redirected post", platforms: ["bluesky"] },
          { idempotencyKey: "redirect-1" },
        ),
      );

      expect(error).toBeInstanceOf(SyndrooApiError);
      expect((error as SyndrooApiError).code).toBe("REDIRECT_NOT_FOLLOWED");
      expect((error as SyndrooApiError).requestMayHaveBeenApplied).toBe(false);
      expect((error as SyndrooApiError).message).toContain("does not follow redirects");

      // The origin received the request, the redirect target received nothing.
      expect(headerOf(requestAt(origin), "authorization")).toBe(`Bearer ${API_KEY}`);
      expect(target.requestCount()).toBe(0);
      expect(target.requests).toHaveLength(0);
    });
  }

  it("refuses redirects on reads and health checks too", async () => {
    const target = await fixture((_request, response) => {
      jsonResponse(response, 200, { status: "ok" });
    });
    const origin = await fixture((_request, response) => {
      redirectResponse(response, 302, `${target.url}/health`);
    });
    const syndroo = new SyndrooClient({ baseUrl: origin.url, apiKey: API_KEY });

    await expect(syndroo.posts.get("post_1")).rejects.toBeInstanceOf(SyndrooApiError);
    await expect(syndroo.health()).rejects.toBeInstanceOf(SyndrooApiError);
    await expect(syndroo.posts.list()).rejects.toBeInstanceOf(SyndrooApiError);

    expect(target.requestCount()).toBe(0);
  });

  it("reports the redirect as a configuration problem, not a delivery", async () => {
    const origin = await fixture((_request, response) => {
      redirectResponse(response, 301, "https://syndroo.example.com/v1/posts");
    });
    const syndroo = new SyndrooClient({ baseUrl: origin.url, apiKey: API_KEY });

    const error = (await captured(
      syndroo.posts.create({ content: "Hello", platforms: ["bluesky"] }),
    )) as SyndrooApiError;

    expect(error.status).toBe(301);
    expect(error.message).toContain("baseUrl");
  });
});

describe("client configuration", () => {
  it("requires an api key and points at the right place to keep it", () => {
    expect(() => new SyndrooClient({ baseUrl: "https://x.example.com", apiKey: "" })).toThrowError(
      /apiKey is required/u,
    );

    try {
      new SyndrooClient({ baseUrl: "https://x.example.com", apiKey: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(SyndrooConfigError);
      expect((error as SyndrooConfigError).message).toContain("NEXT_PUBLIC_");
      expect((error as SyndrooConfigError).requestMayHaveBeenApplied).toBe(false);
    }
  });

  it("refuses an api key that would corrupt the Authorization header", () => {
    expect(
      () =>
        new SyndrooClient({
          baseUrl: "https://x.example.com",
          apiKey: "key with spaces",
        }),
    ).toThrowError(/whitespace/u);

    expect(
      () =>
        new SyndrooClient({
          baseUrl: "https://x.example.com",
          apiKey: "key\nInjected: header",
        }),
    ).toThrowError(/whitespace/u);
  });

  it("rejects unusable base URLs before any request is made", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /baseUrl is required/u],
      ["   ", /baseUrl is required/u],
      ["syndroo.example.com", /absolute URL/u],
      ["ftp://syndroo.example.com", /http or https/u],
      ["https://user:pass@syndroo.example.com", /must not embed credentials/u],
      ["https://syndroo.example.com/?key=1", /query string/u],
    ];

    for (const [baseUrl, pattern] of cases) {
      expect(() => new SyndrooClient({ baseUrl, apiKey: API_KEY })).toThrowError(pattern);
    }
  });

  it("requires https outside loopback unless plaintext is explicitly allowed", () => {
    expect(
      () => new SyndrooClient({ baseUrl: "http://syndroo.example.com", apiKey: API_KEY }),
    ).toThrowError(/https outside loopback/u);

    expect(
      () =>
        new SyndrooClient({
          baseUrl: "http://syndroo.example.com",
          apiKey: API_KEY,
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });

  it("accepts loopback http for local debugging", () => {
    expect(
      () => new SyndrooClient({ baseUrl: "http://127.0.0.1:8787", apiKey: API_KEY }),
    ).not.toThrow();
    expect(
      () => new SyndrooClient({ baseUrl: "http://localhost:8787", apiKey: API_KEY }),
    ).not.toThrow();
  });

  it("requires finite, positive deadlines", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new SyndrooClient({
            baseUrl: "https://x.example.com",
            apiKey: API_KEY,
            timeoutMs,
          }),
      ).toThrowError(/timeoutMs/u);
    }
  });

  it("keeps the response size limit meaningful", () => {
    expect(
      () =>
        new SyndrooClient({
          baseUrl: "https://x.example.com",
          apiKey: API_KEY,
          maxResponseBytes: 16,
        }),
    ).toThrowError(/maxResponseBytes/u);
  });
});

describe("input validation happens before the network", () => {
  it("rejects malformed posts without sending anything", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 500, { error: { code: "UNEXPECTED", message: "should not happen" } });
    });
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });

    const invalid: Array<() => Promise<unknown>> = [
      () => syndroo.posts.create({ content: "", platforms: ["bluesky"] }),
      () => syndroo.posts.create({ content: "   ", platforms: ["bluesky"] }),
      () => syndroo.posts.create({ content: "Hello", platforms: [] }),
      () => syndroo.posts.create({ content: "Hello", platforms: [""] }),
      () =>
        syndroo.posts.create({
          content: "Hello",
          platforms: ["bluesky"],
          scheduledAt: "not-a-date",
        }),
      () =>
        syndroo.posts.create(
          { content: "Hello", platforms: ["bluesky"] },
          { idempotencyKey: "bad key" },
        ),
      () => syndroo.posts.create({ content: "Hello", platforms: ["bluesky"] }, { idempotencyKey: "x".repeat(129) }),
      () => syndroo.posts.get(""),
      () => syndroo.posts.list({ limit: 0 }),
      () => syndroo.posts.list({ limit: 101 }),
    ];

    for (const call of invalid) {
      const error = await captured(call());
      expect(error).toBeInstanceOf(SyndrooValidationError);
    }

    expect(server.requestCount()).toBe(0);
  });
});

async function captured(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the SDK call to reject.");
}
