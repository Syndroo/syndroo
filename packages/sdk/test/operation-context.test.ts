/**
 * Every SDK-generated error names the fixed operation that failed, and the
 * recovery text follows that operation: post-create uncertainty may mention the
 * same idempotency key and status reads, auth uncertainty points at
 * `auth.status`/`auth.operation` and never at a post key, and a read never
 * claims a write.
 *
 * The auth operations are exercised through the internal transport, which is
 * where the wording lives; no auth facade exists yet.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyndrooApiError,
  SyndrooClient,
  SyndrooError,
  SyndrooNetworkError,
  SyndrooResponseError,
  SyndrooWaitTimeoutError,
  type SdkOperation,
  type SyndrooClientOptions,
} from "../src/index.js";
import { sendRequest, type TransportConfig } from "../src/http.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const BASE_URL = "https://syndroo.example.com";

const CONFIG: TransportConfig = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  timeoutMs: 5_000,
  maxResponseBytes: 8 * 1024 * 1024,
};

const READ_OPERATIONS: readonly SdkOperation[] = [
  "health",
  "posts.get",
  "posts.list",
  "posts.wait",
  "auth.status",
  "auth.operation",
  "diagnostics",
];

const WRITE_OPERATIONS: readonly SdkOperation[] = [
  "posts.create",
  "auth.set",
  "auth.connect",
  "auth.complete",
  "auth.refresh",
  "auth.remove",
];

const AUTH_WRITE_OPERATIONS: readonly SdkOperation[] = [
  "auth.set",
  "auth.connect",
  "auth.complete",
  "auth.refresh",
  "auth.remove",
];

const calls: Array<{ method: string; url: string }> = [];

function stubFetch(handler: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return Promise.resolve(handler());
    },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function detail(status: string): Record<string, unknown> {
  return {
    id: "post_1",
    content: "Hello from Syndroo",
    platforms: ["bluesky"],
    status,
    createdAt: "2030-01-02T03:04:05.000Z",
    publications: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

function client(options: Partial<SyndrooClientOptions> = {}): SyndrooClient {
  return new SyndrooClient({ baseUrl: BASE_URL, apiKey: API_KEY, ...options });
}

async function captured(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the SDK call to reject.");
}

function expectSdkError(error: unknown): SyndrooError {
  expect(error).toBeInstanceOf(SyndrooError);

  if (!(error instanceof SyndrooError)) {
    throw new Error("Expected a SyndrooError.");
  }

  return error;
}

function transportMethod(operation: SdkOperation): "GET" | "POST" | "DELETE" {
  if (operation === "auth.remove") {
    return "DELETE";
  }

  return WRITE_OPERATIONS.includes(operation) ? "POST" : "GET";
}

describe("every SDK operation carries a fixed operation field", () => {
  for (const operation of [...READ_OPERATIONS, ...WRITE_OPERATIONS]) {
    const isWrite = WRITE_OPERATIONS.includes(operation);

    it(`reports "${operation}" with requestMayHaveBeenApplied=${isWrite}`, async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("connection lost")));

      const error = await captured(
        sendRequest(CONFIG, {
          method: transportMethod(operation),
          operation,
          path: "/v1/probe",
          authenticated: false,
          timeoutMs: 500,
        }),
      );

      expect(error).toBeInstanceOf(SyndrooNetworkError);
      expect(expectSdkError(error).operation).toBe(operation);
      expect(expectSdkError(error).requestMayHaveBeenApplied).toBe(isWrite);
    });
  }
});

describe("recovery wording follows the operation", () => {
  it("points a post-create uncertainty at the same key and status reads", async () => {
    stubFetch(() =>
      json(500, { error: { code: "INTERNAL_ERROR", message: "boom" } }),
    );

    const error = await captured(
      client().posts.create(
        { content: "Hello", platforms: ["bluesky"] },
        { idempotencyKey: "release-1" },
      ),
    );

    expect(error).toBeInstanceOf(SyndrooApiError);
    expect(expectSdkError(error).operation).toBe("posts.create");
    expect(expectSdkError(error).message).toContain("Idempotency-Key");
    expect(expectSdkError(error).message).toContain("posts.get");
  });

  for (const operation of AUTH_WRITE_OPERATIONS) {
    it(`points "${operation}" uncertainty at auth.status, never at a post key`, async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("connection lost")));

      const error = await captured(
        sendRequest(CONFIG, {
          method: transportMethod(operation),
          operation,
          path: "/v1/auth/x",
          timeoutMs: 500,
        }),
      );

      const message = expectSdkError(error).message;

      expect(message).toContain("auth.status");
      expect(message).not.toContain("Idempotency-Key");
      expect(message).not.toContain("posts.list");
      expect(message).not.toContain("posts.get");
    });
  }

  it("tells a refresh caller never to repeat the exchange automatically", async () => {
    stubFetch(() =>
      json(503, { error: { code: "STORE_UNAVAILABLE", message: "storage down" } }),
    );

    const error = await captured(
      sendRequest(CONFIG, {
        method: "POST",
        operation: "auth.refresh",
        path: "/v1/auth/x/refresh",
        timeoutMs: 500,
      }),
    );

    expect(expectSdkError(error).message).toContain(
      "never repeat the exchange automatically",
    );
  });

  it("allows an explicit replay of a completed operation but never performs one", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("connection lost")));

    const error = await captured(
      sendRequest(CONFIG, {
        method: "POST",
        operation: "auth.complete",
        path: "/v1/auth/x/operations/op_1/complete",
        timeoutMs: 500,
      }),
    );

    const message = expectSdkError(error).message;

    expect(message).toContain("replayed explicitly");
    expect(message).toContain("never replays it for you");
  });

  it("reports a failed read as a read, never as a lost write", async () => {
    stubFetch(() =>
      json(500, { error: { code: "INTERNAL_ERROR", message: "boom" } }),
    );

    const error = await captured(client().posts.get("post_1"));

    expect(expectSdkError(error).operation).toBe("posts.get");
    expect(expectSdkError(error).requestMayHaveBeenApplied).toBe(false);
    expect(expectSdkError(error).message).toContain("read");
  });
});

describe("the public client attaches its own operation", () => {
  const malformedCases: ReadonlyArray<{
    operation: SdkOperation;
    run: (syndroo: SyndrooClient) => Promise<unknown>;
  }> = [
    { operation: "health", run: (syndroo) => syndroo.health() },
    {
      operation: "posts.create",
      run: (syndroo) =>
        syndroo.posts.create({ content: "Hello", platforms: ["bluesky"] }),
    },
    { operation: "posts.get", run: (syndroo) => syndroo.posts.get("post_1") },
    { operation: "posts.list", run: (syndroo) => syndroo.posts.list() },
  ];

  for (const testCase of malformedCases) {
    it(`reports "${testCase.operation}" for a malformed 2xx`, async () => {
      stubFetch(() => json(200, null));

      const error = await captured(testCase.run(client()));

      expect(error).toBeInstanceOf(SyndrooResponseError);
      expect(expectSdkError(error).operation).toBe(testCase.operation);
      expect(expectSdkError(error).requestMayHaveBeenApplied).toBe(
        testCase.operation === "posts.create",
      );
    });
  }

  it("reports validation failures with the operation that rejected them", async () => {
    const syndroo = client();
    const cases: ReadonlyArray<{
      operation: SdkOperation;
      run: () => Promise<unknown>;
    }> = [
      {
        operation: "posts.create",
        run: () =>
          syndroo.posts.create({ content: "", platforms: ["bluesky"] }),
      },
      {
        operation: "posts.create",
        run: () =>
          syndroo.posts.create(
            { content: "Hello", platforms: ["bluesky"] },
            { idempotencyKey: "bad key" },
          ),
      },
      { operation: "posts.get", run: () => syndroo.posts.get("") },
      { operation: "posts.list", run: () => syndroo.posts.list({ limit: 0 }) },
      {
        operation: "posts.wait",
        run: () => syndroo.posts.wait("post_1", { timeoutMs: 0 }),
      },
      {
        operation: "posts.get",
        run: () => syndroo.posts.get("post_1", { timeoutMs: 0 }),
      },
      {
        operation: "health",
        run: () => syndroo.health({ timeoutMs: Number.NaN }),
      },
    ];

    for (const testCase of cases) {
      const error = expectSdkError(await captured(testCase.run()));

      expect(error.operation).toBe(testCase.operation);
      expect(error.requestMayHaveBeenApplied).toBe(false);
    }

    // Every one of these was rejected before a request existed.
    expect(calls).toEqual([]);
  });

  it("never puts caller data in the operation field or the error text", async () => {
    const sentinel = "SENTINEL_POST_ID_TOKEN";
    stubFetch(() =>
      json(404, {
        error: { code: "POST_NOT_FOUND", message: `no such post ${sentinel}` },
      }),
    );

    const error = expectSdkError(await captured(client().posts.get(sentinel)));
    const preview = (error as { preview?: unknown }).preview;
    const text = [
      error.message,
      error.stack ?? "",
      JSON.stringify(error),
      String(error.cause),
      String(preview),
    ].join("\n");

    expect(error.operation).toBe("posts.get");
    expect(text).not.toContain(sentinel);
  });
});

describe("posts.wait reports its own operation", () => {
  it("keeps posts.wait on a reached deadline", async () => {
    stubFetch(() => json(200, detail("queued")));

    const error = await captured(
      client().posts.wait("post_1", { timeoutMs: 150, pollIntervalMs: 20 }),
    );

    expect(error).toBeInstanceOf(SyndrooWaitTimeoutError);
    expect(expectSdkError(error).operation).toBe("posts.wait");
    expect(expectSdkError(error).requestMayHaveBeenApplied).toBe(false);
  });

  it("keeps posts.wait on a fatal server rejection", async () => {
    stubFetch(() =>
      json(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    );

    const error = await captured(
      client().posts.wait("post_1", { timeoutMs: 2_000, pollIntervalMs: 10 }),
    );

    expect(error).toBeInstanceOf(SyndrooApiError);
    expect(expectSdkError(error).operation).toBe("posts.wait");
  });

  it("keeps posts.wait on a malformed read body", async () => {
    stubFetch(() => json(200, null));

    const error = await captured(
      client().posts.wait("post_1", { timeoutMs: 150, pollIntervalMs: 20 }),
    );

    expect(error).toBeInstanceOf(SyndrooWaitTimeoutError);
    expect(expectSdkError(error).operation).toBe("posts.wait");

    const lastError = (error as SyndrooWaitTimeoutError).lastError;

    expect(lastError?.operation).toBe("posts.wait");
    expect(lastError?.requestMayHaveBeenApplied).toBe(false);
  });
});
