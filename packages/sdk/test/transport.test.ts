/**
 * Transport-level behavior: endpoints, headers, bounds, redirects, retries and
 * failure classification. All requests go to a scripted in-memory `fetch`.
 */

import { describe, expect, it } from "vitest";

import { LIMITS, Syndroo, SyndrooError } from "../src/index.js";
import type { PrepareRequest } from "../src/index.js";
import { FakeHttp, oversizedChunks, textBytes } from "./support/fake-http.js";
import {
  EXECUTION_PENDING,
  EXECUTION_SUCCEEDED,
  PREPARED,
  STATUS_CONNECTIONS,
  okEnvelope,
} from "./support/wire-fixtures.js";

const BASE_URL = "https://syndroo.example";
const API_KEY = "sdk-test-key";

async function errorOf(run: () => Promise<unknown>): Promise<SyndrooError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SyndrooError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to reject");
}

function prepareBody(text = "hello"): PrepareRequest {
  return { type: "prepare", content: { text }, targets: [{ provider: "bluesky" }] };
}

function client(http: FakeHttp, baseUrl = BASE_URL): Syndroo {
  return new Syndroo({ baseUrl, apiKey: API_KEY, fetch: http.fetch });
}

describe("base URL policy", () => {
  const rejected = [
    "http://syndroo.example",
    "https://user:pass@syndroo.example",
    "https://syndroo.example/#fragment",
    "https://syndroo.example/?query=1",
    "ftp://syndroo.example",
    "not a url",
    "",
  ];

  it.each(rejected)("rejects %j before any request", (baseUrl) => {
    const http = new FakeHttp([{ kind: "json", status: 200, body: {} }]);
    let caught: unknown;
    try {
      client(http, baseUrl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyndrooError);
    expect((caught as SyndrooError).code).toBe("INSECURE_BASE_URL");
    expect(http.callCount).toBe(0);
  });

  it.each(["https://syndroo.example", "http://127.0.0.1:8787", "http://localhost:8787"])(
    "accepts %j",
    (baseUrl) => {
      expect(() => client(new FakeHttp([]), baseUrl)).not.toThrow();
    },
  );
});

describe("request shape", () => {
  it("posts to /v1/<operation> with a mandatory bearer and manual redirects", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    await client(http).publish(prepareBody());

    expect(http.requests).toHaveLength(1);
    const sent = http.requests[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe(`${BASE_URL}/v1/publish`);
    expect(sent?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(sent?.headers.accept).toBe("application/json");
    expect(sent?.redirect).toBe("manual");
    expect(JSON.parse(sent?.body ?? "null")).toMatchObject({ type: "prepare" });
  });

  it("keeps a base path and drops trailing slashes", async () => {
    const http = new FakeHttp([{ kind: "json", status: 200, body: okEnvelope("status", { type: "connections", connections: [] }) }]);
    await client(http, "https://syndroo.example/syndroo/").status({ type: "connections" });
    expect(http.requests[0]?.url).toBe("https://syndroo.example/syndroo/v1/status");
  });

  it("rejects a request body over the 64 KiB bound without sending it", async () => {
    const http = new FakeHttp([]);
    const error = await errorOf(() =>
      client(http).publish(prepareBody("x".repeat(LIMITS.maxRequestBytes + 1))),
    );
    expect(error.code).toBe("INVALID_REQUEST");
    expect(http.callCount).toBe(0);
  });

  it("rejects a request that does not match the wire schema", async () => {
    const http = new FakeHttp([]);
    const error = await errorOf(() =>
      client(http).connect({ type: "start" } as never),
    );
    expect(error.code).toBe("INVALID_REQUEST");
    expect(http.callCount).toBe(0);
  });
});

describe("response handling", () => {
  it("tolerates extra response fields in the envelope and the result", async () => {
    const http = new FakeHttp([
      {
        kind: "json",
        status: 200,
        body: { ...okEnvelope("publish", { ...PREPARED, extra: "ignored" }), extra: 1 },
      },
    ]);
    const result = await client(http).publish(prepareBody());
    expect(result.status).toBe("confirmation_required");
  });

  it("fails safe on an unknown enum value", async () => {
    const http = new FakeHttp([
      {
        kind: "json",
        status: 200,
        body: okEnvelope("status", { type: "overview", initialized: true, connectionCount: 0, providers: [], recent: [], stateHealth: "broken" }),
      },
    ]);
    const error = await errorOf(() => client(http).status({ type: "overview" }));
    expect(error.code).toBe("INVALID_RESPONSE");
    expect(http.callCount).toBe(1);
  });

  it("fails safe when the envelope operation does not match the call", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("fails safe on invalid JSON", async () => {
    const http = new FakeHttp([
      { kind: "bytes", status: 200, bytes: textBytes("{not json") },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("fails safe on invalid UTF-8", async () => {
    const http = new FakeHttp([
      { kind: "bytes", status: 200, bytes: Uint8Array.from([0x7b, 0xff, 0x7d]) },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("rejects a response that declares more than 1 MiB", async () => {
    const http = new FakeHttp([
      {
        kind: "stream",
        status: 200,
        chunks: [textBytes("{}")],
        headers: { "content-length": String(LIMITS.maxResponseBytes + 1) },
      },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("releases the body and aborts the request when the declared size is too large", async () => {
    const http = new FakeHttp([
      {
        kind: "endless",
        status: 200,
        headers: { "content-length": String(LIMITS.maxResponseBytes + 1) },
      },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("RESPONSE_TOO_LARGE");
    expect(http.cancelled).toHaveLength(1);
    expect(http.requests[0]?.signal?.aborted).toBe(true);
  });

  it("caps a streamed response at 1 MiB", async () => {
    const http = new FakeHttp([{ kind: "stream", status: 200, chunks: oversizedChunks() }]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("surfaces a rejection envelope as a protocol error without retrying", async () => {
    const http = new FakeHttp([
      {
        kind: "json",
        status: 409,
        body: {
          protocolVersion: 1,
          operation: "publish",
          ok: false,
          result: null,
          error: { code: "IDEMPOTENCY_CONFLICT", message: "static server message" },
        },
      },
    ]);
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), { transportRetries: 2 }),
    );
    expect(error.code).toBe("PROTOCOL");
    expect(error.serverError?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(http.callCount).toBe(1);
  });
});

describe("redirects", () => {
  it("never follows a redirect and never retries it", async () => {
    const http = new FakeHttp([
      { kind: "empty", status: 302 },
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), { transportRetries: 2 }),
    );
    expect(error.code).toBe("REDIRECT_NOT_ALLOWED");
    expect(http.callCount).toBe(1);
  });

  it("releases the body and aborts the request when the server redirects", async () => {
    const http = new FakeHttp([{ kind: "endless", status: 302 }]);
    const error = await errorOf(() => client(http).publish(prepareBody()));
    expect(error.code).toBe("REDIRECT_NOT_ALLOWED");
    expect(http.cancelled).toHaveLength(1);
    expect(http.requests[0]?.signal?.aborted).toBe(true);
  });
});

describe("202 correlation", () => {
  it("accepts 202 for an admitted, still-running execution", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 202, body: okEnvelope("publish", EXECUTION_PENDING) },
    ]);
    const result = await client(http).publish({ type: "execute", approvalToken: "approval_1" });
    expect(result.status).toBe("pending");
  });

  it("rejects 202 for a terminal execution", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 202, body: okEnvelope("publish", EXECUTION_SUCCEEDED) },
    ]);
    const error = await errorOf(() =>
      client(http).publish({ type: "execute", approvalToken: "approval_1" }),
    );
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("rejects 202 for a prepared result", async () => {
    const http = new FakeHttp([{ kind: "json", status: 202, body: okEnvelope("publish", PREPARED) }]);
    const error = await errorOf(() => client(http).publish(prepareBody()));
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("rejects 202 for a status query", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 202, body: okEnvelope("status", STATUS_CONNECTIONS) },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("INVALID_RESPONSE");
  });
});

describe("idempotency key grammar", () => {
  it.each(["spaces in key", "x".repeat(LIMITS.maxIdempotencyKeyLength + 1), "sl@sh", ""])(
    "rejects %j before sending",
    async (key) => {
      const http = new FakeHttp([]);
      const error = await errorOf(() => client(http).publish(prepareBody(), { idempotencyKey: key }));
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(http.callCount).toBe(0);
    },
  );

  it.each(["a", "x".repeat(LIMITS.maxIdempotencyKeyLength), "req.abc-123_XY:z"])(
    "accepts %j and sends it verbatim",
    async (key) => {
      const http = new FakeHttp([
        { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
      ]);
      await client(http).publish(prepareBody(), { idempotencyKey: key });
      expect(http.requests[0]?.headers["idempotency-key"]).toBe(key);
    },
  );
});

describe("transport retries", () => {
  it("does not retry by default", async () => {
    const http = new FakeHttp([{ kind: "throw", error: new TypeError("network down") }]);
    const error = await errorOf(() => client(http).publish(prepareBody()));
    expect(error.code).toBe("TRANSPORT");
    expect(error.retryable).toBe(true);
    expect(http.callCount).toBe(1);
  });

  it("retries a transport failure with the same idempotency key", async () => {
    const http = new FakeHttp([
      { kind: "throw", error: new TypeError("network down") },
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const result = await client(http).publish(prepareBody(), { transportRetries: 1 });
    expect(result.status).toBe("confirmation_required");
    expect(http.callCount).toBe(2);
    const keys = http.requests.map((request) => request.headers["idempotency-key"]);
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
  });

  it("does not retry a non-retryable HTTP status", async () => {
    const http = new FakeHttp([
      { kind: "empty", status: 400 },
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), { transportRetries: 2 }),
    );
    expect(error.code).toBe("HTTP_ERROR");
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(http.callCount).toBe(1);
  });

  it("retries a gateway status that carried no envelope", async () => {
    const http = new FakeHttp([
      { kind: "empty", status: 503 },
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const result = await client(http).publish(prepareBody(), { transportRetries: 2 });
    expect(result.status).toBe("confirmation_required");
    expect(http.callCount).toBe(2);
  });

  it("retries a deadline with the same idempotency key", async () => {
    const http = new FakeHttp([
      { kind: "hang" },
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const result = await client(http).publish(prepareBody(), {
      transportRetries: 1,
      timeoutMs: 20,
    });
    expect(result.status).toBe("confirmation_required");
    expect(http.callCount).toBe(2);
    expect(http.requests[0]?.headers["idempotency-key"]).toBe(
      http.requests[1]?.headers["idempotency-key"],
    );
  });

  it("classifies a deadline as TIMEOUT when retries are exhausted", async () => {
    const http = new FakeHttp([{ kind: "hang" }]);
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), { timeoutMs: 20 }),
    );
    expect(error.code).toBe("TIMEOUT");
    expect(http.callCount).toBe(1);
  });
});

describe("cancellation", () => {
  it("rejects an already aborted call without sending", async () => {
    const http = new FakeHttp([{ kind: "json", status: 200, body: okEnvelope("publish", PREPARED) }]);
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), { signal: controller.signal }),
    );
    expect(error.code).toBe("ABORTED");
    expect(http.callCount).toBe(0);
  });

  it("aborts an in-flight call without retrying it", async () => {
    const http = new FakeHttp([
      { kind: "hang" },
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), {
        signal: controller.signal,
        transportRetries: 2,
        timeoutMs: 5000,
      }),
    );
    expect(error.code).toBe("ABORTED");
    expect(http.callCount).toBe(1);
  });
});

describe("option bounds", () => {
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: LIMITS.maxTimeoutMs + 1 },
    { transportRetries: -1 },
    { transportRetries: LIMITS.maxTransportRetries + 1 },
  ])("rejects %j", async (options) => {
    const http = new FakeHttp([]);
    const error = await errorOf(() =>
      client(http).publish(prepareBody(), options as never),
    );
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(http.callCount).toBe(0);
  });
});
