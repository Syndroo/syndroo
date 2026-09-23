/**
 * `diagnostics()`: one read-only request, projected into the documented shape.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyndrooClient,
  SyndrooError,
  SyndrooResponseError,
  type Diagnostics,
  type SyndrooClientOptions,
} from "../src/index.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const BASE_URL = "https://syndroo.example.com";
const SENTINEL = "SENTINEL_SECRET_VALUE_9f3a";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const calls: Call[] = [];

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  );
}

const DIAGNOSTICS = {
  observedAt: "2030-01-02T03:04:05.000Z",
  pendingOutbox: 2,
  oldestDueAt: "2030-01-02T03:00:00.000Z",
  oldestAgeSeconds: 245,
  retryScheduled: 1,
  deadLettered: 0,
  latestAttemptArchiveFailures: 0,
  storage: {
    approximateBytes: 4_096,
    limitBytes: 10_485_760,
    utilization: 0.0004,
    reason: null,
    observedAt: "2030-01-02T03:04:05.000Z",
  },
};

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

describe("diagnostics", () => {
  it("reads the documented counters from GET /v1/diagnostics", async () => {
    stubFetch(DIAGNOSTICS);

    const diagnostics: Diagnostics = await client().diagnostics();

    expect(diagnostics.pendingOutbox).toBe(2);
    expect(diagnostics.oldestAgeSeconds).toBe(245);
    expect(diagnostics.storage.utilization).toBe(0.0004);
    expect(diagnostics.storage.reason).toBeNull();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/diagnostics`);
    expect(calls[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls).toHaveLength(1);
  });

  it("keeps unknown storage numbers null instead of guessing", async () => {
    stubFetch({
      ...DIAGNOSTICS,
      oldestDueAt: null,
      oldestAgeSeconds: null,
      storage: {
        approximateBytes: null,
        limitBytes: null,
        utilization: null,
        reason: "size_unavailable",
        observedAt: "2030-01-02T03:04:05.000Z",
      },
    });

    const diagnostics = await client().diagnostics();

    expect(diagnostics.oldestDueAt).toBeNull();
    expect(diagnostics.oldestAgeSeconds).toBeNull();
    expect(diagnostics.storage.approximateBytes).toBeNull();
    expect(diagnostics.storage.limitBytes).toBeNull();
    expect(diagnostics.storage.utilization).toBeNull();
    expect(diagnostics.storage.reason).toBe("size_unavailable");
  });

  it("rejects any storage reason the deployment does not document", async () => {
    for (const storage of [
      {
        approximateBytes: null,
        limitBytes: null,
        utilization: null,
        reason: SENTINEL,
        observedAt: "2030-01-02T03:04:05.000Z",
      },
      {
        // Unknown size with no reason at all is a contract failure too.
        approximateBytes: null,
        limitBytes: 10_485_760,
        utilization: null,
        reason: null,
        observedAt: "2030-01-02T03:04:05.000Z",
      },
    ]) {
      stubFetch({ ...DIAGNOSTICS, storage });

      const error = expectSdkError(await captured(client().diagnostics()));

      expect(error).toBeInstanceOf(SyndrooResponseError);
      expect(error.message).not.toContain(SENTINEL);
    }
  });

  it("accepts the documented reason when a size is unknown and keeps null when both are known", async () => {
    stubFetch({
      ...DIAGNOSTICS,
      storage: {
        ...DIAGNOSTICS.storage,
        limitBytes: null,
        utilization: null,
        reason: "size_unavailable",
      },
    });

    const unknown = await client().diagnostics();

    expect(unknown.storage.reason).toBe("size_unavailable");

    stubFetch(DIAGNOSTICS);

    const known = await client().diagnostics();

    expect(known.storage.reason).toBeNull();
  });

  it("projects unknown fields away", async () => {
    stubFetch({
      ...DIAGNOSTICS,
      extra: SENTINEL,
      storage: { ...DIAGNOSTICS.storage, extra: SENTINEL },
    });

    const diagnostics = await client().diagnostics();

    expect(JSON.stringify(diagnostics)).not.toContain(SENTINEL);
    expect(Object.keys(diagnostics).sort()).toEqual([
      "deadLettered",
      "latestAttemptArchiveFailures",
      "observedAt",
      "oldestAgeSeconds",
      "oldestDueAt",
      "pendingOutbox",
      "retryScheduled",
      "storage",
    ]);
  });

  it("rejects a malformed read as a read, with the real status", async () => {
    stubFetch(null);

    const error = expectSdkError(await captured(client().diagnostics()));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect((error as SyndrooResponseError).status).toBe(200);
    expect(error.operation).toBe("diagnostics");
    expect(error.requestMayHaveBeenApplied).toBe(false);
  });

  it("rejects out-of-range counts, ages, bytes, and utilization", async () => {
    const bodies = [
      { ...DIAGNOSTICS, pendingOutbox: -1 },
      { ...DIAGNOSTICS, oldestAgeSeconds: -1 },
      { ...DIAGNOSTICS, storage: { ...DIAGNOSTICS.storage, approximateBytes: -1 } },
      { ...DIAGNOSTICS, storage: { ...DIAGNOSTICS.storage, utilization: 1.5 } },
      { ...DIAGNOSTICS, storage: { ...DIAGNOSTICS.storage, utilization: -0.1 } },
      {
        ...DIAGNOSTICS,
        storage: {
          ...DIAGNOSTICS.storage,
          approximateBytes: null,
          utilization: 0.5,
        },
      },
      { ...DIAGNOSTICS, observedAt: "not-a-date" },
      { ...DIAGNOSTICS, observedAt: "1" },
      { ...DIAGNOSTICS, observedAt: "2026-02-30T00:00:00.000Z" },
      { ...DIAGNOSTICS, observedAt: "2030-01-02T03:04:05Z" },
    ];

    for (const body of bodies) {
      stubFetch(body);

      const error = expectSdkError(await captured(client().diagnostics()));

      expect(error).toBeInstanceOf(SyndrooResponseError);
    }
  });

  it("accepts a ratio when both numbers are known", async () => {
    stubFetch({
      ...DIAGNOSTICS,
      storage: { ...DIAGNOSTICS.storage, utilization: 0.5 },
    });

    const diagnostics = await client().diagnostics();

    expect(diagnostics.storage.utilization).toBe(0.5);
  });

  it("never echoes a value it rejected", async () => {
    stubFetch({ ...DIAGNOSTICS, observedAt: SENTINEL });

    const error = expectSdkError(await captured(client().diagnostics()));

    expect(error.message).not.toContain(SENTINEL);
  });
});
