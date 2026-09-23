import { afterEach, describe, expect, it } from "vitest";

import {
  SyndrooApiError,
  SyndrooClient,
  SyndrooResponseError,
  type SyndrooClientOptions,
} from "../src/index.js";
import {
  jsonResponse,
  textResponse,
  startFixtureServer,
  type FixtureServer,
  type FixtureHandler,
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

async function fixture(handler: FixtureHandler): Promise<FixtureServer> {
  const server = await startFixtureServer(handler);
  servers.push(server);
  return server;
}

function client(
  server: FixtureServer,
  options: Partial<SyndrooClientOptions> = {},
): SyndrooClient {
  return new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY, ...options });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Promise<FixtureServer> {
  return fixture((_request, response) => {
    if (status === 429) {
      response.setHeader("retry-after", "2");
    }

    jsonResponse(response, status, { error: { code, message } });
  });
}

const CASES = [
  {
    status: 400,
    code: "INVALID_REQUEST",
    message: "platforms must be a non-empty array",
    applied: false,
  },
  {
    status: 401,
    code: "UNAUTHORIZED",
    message: "Unauthorized",
    applied: false,
  },
  {
    status: 404,
    code: "POST_NOT_FOUND",
    message: "Post not found",
    applied: false,
  },
  {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "Idempotency-Key was already used with a different request",
    applied: false,
  },
  {
    status: 422,
    code: "PLATFORM_NOT_CONFIGURED",
    message: "platforms[0] is not configured on this deployment",
    applied: false,
  },
  {
    status: 429,
    code: "RATE_LIMITED",
    message: "Too many requests",
    applied: false,
  },
  {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    message:
      "Syndroo is in maintenance mode and is not accepting new posts; retry later with the same Idempotency-Key and request body",
    applied: true,
  },
] as const;

describe("typed HTTP errors", () => {
  for (const testCase of CASES) {
    it(`surfaces HTTP ${testCase.status} ${testCase.code} as a SyndrooApiError`, async () => {
      const server = await errorResponse(
        testCase.status,
        testCase.code,
        testCase.message,
      );

      const error = expectApiError(
        await captured(
          client(server).posts.create({ content: "Hello", platforms: ["bluesky"] }),
        ),
      );

      expect(error.status).toBe(testCase.status);
      expect(error.code).toBe(testCase.code);
      // The server's own message may carry provider or storage text, so the SDK
      // reports a fixed message naming the status and the allowlisted code.
      expect(error.message).toContain(`HTTP ${testCase.status}`);
      expect(error.message).toContain(testCase.code);
      expect(error.message).not.toContain(testCase.message);
      expect(error.requestMayHaveBeenApplied).toBe(testCase.applied);
      expect(error.retryable).toBe(testCase.status === 429 || testCase.status >= 500);
      expect(error.message).not.toContain(API_KEY);
      expect(server.requestCount()).toBe(1);
    });
  }

  it("reads Retry-After into a bounded backpressure hint", async () => {
    const server = await errorResponse(
      429,
      "RATE_LIMITED",
      "Too many requests",
    );

    const error = expectApiError(
      await captured(
        client(server).posts.get("post_1"),
      ),
    );

    expect(error.retryAfterMs).toBe(2_000);
  });

  it("never treats a 5xx as a rejection of a write", async () => {
    const server = await errorResponse(
      500,
      "INTERNAL_ERROR",
      "Internal server error",
    );

    const error = expectApiError(
      await captured(
        client(server).posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(error.message).not.toMatch(/not created|did not create/u);
  });
});

describe("malformed responses", () => {
  it("keeps a non-JSON body bounded and never reports a write as accepted", async () => {
    const server = await fixture((_request, response) => {
      textResponse(response, 202, "<html>not json</html>", "text/html");
    });

    const error = expectResponseError(
      await captured(
        client(server).posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error.status).toBe(202);
    expect(error.requestMayHaveBeenApplied).toBe(true);
    // `preview` stays available for compatibility but is never filled from an
    // untrusted body.
    expect(error.preview).toBeUndefined();
    expect(error.message).toContain("not JSON");
    expect(error.message).not.toContain("not json");
  });

  it("bounds the preview of an oversized non-JSON body", async () => {
    const server = await fixture((_request, response) => {
      textResponse(response, 200, "x".repeat(10_000), "text/html");
    });

    const error = expectResponseError(
      await captured(client(server).posts.get("post_1")),
    );

    expect(error.preview).toBeUndefined();
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).not.toContain("xxxx");
  });

  it("fails loudly when a success response is missing required fields", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 202, {});
    });

    const error = expectResponseError(
      await captured(
        client(server).posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error.message).toContain("create response id");
    expect(error.requestMayHaveBeenApplied).toBe(true);
  });

  it("fails loudly when a post detail drops a documented field", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, {
        id: "post_1",
        status: "published",
        platforms: ["bluesky"],
        createdAt: "2030-01-02T03:04:05.000Z",
        publications: [],
      });
    });

    const error = expectResponseError(
      await captured(client(server).posts.get("post_1")),
    );

    expect(error.message).toContain("post content");
    expect(error.requestMayHaveBeenApplied).toBe(false);
  });

  it("rejects a response above the configured size limit", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, { items: [], padding: "a".repeat(5_000) });
    });

    const error = expectResponseError(
      await captured(client(server, { maxResponseBytes: 2_048 }).posts.list()),
    );

    expect(error.message).toContain("2048");
    expect(server.requestCount()).toBe(1);
  });

  it("carries a usable error envelope even when the failure body is HTML", async () => {
    const server = await fixture((_request, response) => {
      textResponse(response, 500, "<html>bad gateway</html>", "text/html");
    });

    const error = expectApiError(
      await captured(client(server).posts.get("post_1")),
    );

    expect(error.code).toBe("HTTP_500");
    expect(error.status).toBe(500);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).not.toContain("bad gateway");
  });
});

function expectApiError(error: unknown): SyndrooApiError {
  expect(error).toBeInstanceOf(SyndrooApiError);

  if (!(error instanceof SyndrooApiError)) {
    throw new Error("Expected a SyndrooApiError.");
  }

  return error;
}

function expectResponseError(error: unknown): SyndrooResponseError {
  expect(error).toBeInstanceOf(SyndrooResponseError);

  if (!(error instanceof SyndrooResponseError)) {
    throw new Error("Expected a SyndrooResponseError.");
  }

  return error;
}

async function captured(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the SDK call to reject.");
}
