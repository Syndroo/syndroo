import { afterEach, describe, expect, it } from "vitest";

import {
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooClient,
  SyndrooTimeoutError,
  SyndrooWaitTimeoutError,
} from "../src/index.js";
import {
  hold,
  jsonResponse,
  requestAt,
  startFixtureServer,
  waitFor,
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

function detail(status: string): Record<string, unknown> {
  return {
    id: "post_1",
    content: "Hello from Syndroo",
    platforms: ["bluesky"],
    status,
    createdAt: "2030-01-02T03:04:05.000Z",
    publications: [
      {
        id: "pub_1",
        postId: "post_1",
        platform: "bluesky",
        provider: "bluesky-native",
        content: "Hello from Syndroo",
        status,
        attempts: 1,
      },
    ],
  };
}

describe("aborting requests", () => {
  it("reports an aborted POST as an unknown outcome and never resends it", async () => {
    const server = await fixture(() => hold());
    const controller = new AbortController();
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });
    const pending = syndroo.posts.create(
      { content: "Aborted post", platforms: ["bluesky"] },
      { idempotencyKey: "abort-1", signal: controller.signal },
    );

    await waitFor(() => server.requestCount() === 1);
    controller.abort();

    const error = expectAbortError(await captured(pending));

    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(error.message).toContain("may still have accepted");
    expect(server.requestCount()).toBe(1);
    expect(JSON.parse(requestAt(server).body)).toEqual({
      content: "Aborted post",
      platforms: ["bluesky"],
    });
  });

  it("reports an aborted GET as safe", async () => {
    const server = await fixture(() => hold());
    const controller = new AbortController();
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });
    const pending = syndroo.posts.get("post_1", { signal: controller.signal });

    await waitFor(() => server.requestCount() === 1);
    controller.abort();

    const error = expectAbortError(await captured(pending));

    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(error.message).toContain("read");
  });

  it("sends nothing when the signal was already aborted", async () => {
    const server = await fixture(() => hold());
    const controller = new AbortController();
    controller.abort();

    const error = expectAbortError(
      await captured(
        new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY }).posts.create(
          { content: "Never sent", platforms: ["bluesky"] },
          { signal: controller.signal },
        ),
      ),
    );

    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(error.message).toContain("before it was sent");
    expect(server.requestCount()).toBe(0);
  });
});

describe("request deadlines", () => {
  it("does not conclude that a timed-out POST was not created", async () => {
    const server = await fixture(() => hold());
    const syndroo = new SyndrooClient({
      baseUrl: server.url,
      apiKey: API_KEY,
      timeoutMs: 50,
    });

    const error = expectTimeoutError(
      await captured(
        syndroo.posts.create(
          { content: "Slow post", platforms: ["bluesky"] },
          { idempotencyKey: "timeout-1" },
        ),
      ),
    );

    expect(error.timeoutMs).toBe(50);
    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(error.message).toMatch(/may still have accepted/u);
    expect(error.message).not.toMatch(/not created|was not sent|safe to retry/iu);
    expect(server.requestCount()).toBe(1);
  });

  it("treats a timed-out read as safe", async () => {
    const server = await fixture(() => hold());
    const syndroo = new SyndrooClient({
      baseUrl: server.url,
      apiKey: API_KEY,
      timeoutMs: 50,
    });

    const error = expectTimeoutError(
      await captured(syndroo.posts.get("post_1")),
    );

    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(error.message).toContain("nothing was created");
  });
});

describe("bounded status wait", () => {
  it("stops at its own deadline, keeps the last status, and only ever reads", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, detail("queued"));
    });
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });
    const startedAt = Date.now();

    const error = expectWaitTimeout(
      await captured(
        syndroo.posts.wait("post_1", {
          timeoutMs: 400,
          pollIntervalMs: 40,
          maxPollIntervalMs: 120,
        }),
      ),
    );
    const elapsed = Date.now() - startedAt;

    expect(error.postId).toBe("post_1");
    expect(error.timeoutMs).toBe(400);
    expect(error.lastStatus).toBe("queued");
    expect(error.lastPost?.status).toBe("queued");
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(error.message).toContain("Stopped waiting");
    expect(error.message).toContain("no post was created or cancelled");
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(3_000);
    expect(server.requestCount()).toBeGreaterThanOrEqual(2);
    expect(server.requestCount()).toBeLessThanOrEqual(15);
    expect(server.requests.every(entry => entry.method === "GET")).toBe(true);
  });

  it("keeps waiting through transient server failures", async () => {
    const server = await fixture((_request, response, index) => {
      if (index < 2) {
        jsonResponse(response, 500, {
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        });
        return;
      }

      jsonResponse(response, 200, detail("published"));
    });
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });

    const post = await syndroo.posts.wait("post_1", {
      timeoutMs: 5_000,
      pollIntervalMs: 20,
    });

    expect(post.status).toBe("published");
    expect(server.requestCount()).toBe(3);
  });

  it("fails fast on an authentication error instead of polling", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 401, {
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    });
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });

    const error = expectApiError(
      await captured(
        syndroo.posts.wait("post_1", { timeoutMs: 5_000, pollIntervalMs: 10 }),
      ),
    );

    expect(error.status).toBe(401);
    expect(server.requestCount()).toBe(1);
  });

  it("can be aborted while it is sleeping between reads", async () => {
    const server = await fixture((_request, response) => {
      jsonResponse(response, 200, detail("queued"));
    });
    const controller = new AbortController();
    const syndroo = new SyndrooClient({ baseUrl: server.url, apiKey: API_KEY });
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      controller.abort();
    }, 80);

    try {
      const error = expectAbortError(
        await captured(
          syndroo.posts.wait("post_1", {
            timeoutMs: 30_000,
            pollIntervalMs: 1_000,
            signal: controller.signal,
          }),
        ),
      );

      expect(error.requestMayHaveBeenApplied).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      clearTimeout(timer);
    }
  });

  it("rejects an unbounded wait configuration", () => {
    expect(
      () =>
        new SyndrooClient({
          baseUrl: "https://syndroo.example.com",
          apiKey: API_KEY,
          waitTimeoutMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrowError(/waitTimeoutMs/u);
  });
});

function expectAbortError(error: unknown): SyndrooAbortError {
  expect(error).toBeInstanceOf(SyndrooAbortError);

  if (!(error instanceof SyndrooAbortError)) {
    throw new Error("Expected a SyndrooAbortError.");
  }

  return error;
}

function expectTimeoutError(error: unknown): SyndrooTimeoutError {
  expect(error).toBeInstanceOf(SyndrooTimeoutError);

  if (!(error instanceof SyndrooTimeoutError)) {
    throw new Error("Expected a SyndrooTimeoutError.");
  }

  return error;
}

function expectWaitTimeout(error: unknown): SyndrooWaitTimeoutError {
  expect(error).toBeInstanceOf(SyndrooWaitTimeoutError);

  if (!(error instanceof SyndrooWaitTimeoutError)) {
    throw new Error("Expected a SyndrooWaitTimeoutError.");
  }

  return error;
}

function expectApiError(error: unknown): SyndrooApiError {
  expect(error).toBeInstanceOf(SyndrooApiError);

  if (!(error instanceof SyndrooApiError)) {
    throw new Error("Expected a SyndrooApiError.");
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
