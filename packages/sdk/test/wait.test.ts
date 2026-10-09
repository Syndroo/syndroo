/**
 * `wait` behavior: status-only polling, delivery-based round completion,
 * confirmation errors, bounds and cancellation.
 */

import { describe, expect, it } from "vitest";

import {
  WAIT_LIMITS,
  Syndroo,
  SyndrooError,
  isExecutionRoundComplete,
  waitForExecutionRound,
} from "../src/index.js";
import type { ExecutionResult, OperationView } from "../src/index.js";
import { FakeHttp } from "./support/fake-http.js";
import {
  EXECUTION_PENDING,
  EXECUTION_SUCCEEDED,
  EXECUTION_UNKNOWN_WITH_OPEN_DELIVERY,
  okEnvelope,
} from "./support/wire-fixtures.js";

const BASE_URL = "https://syndroo.example";

const PREPARED_REQUIRED = {
  phase: "prepared",
  operationId: "op_1",
  confirmation: "required",
  expiresAt: "2026-10-08T00:15:00.000Z",
  preview: [],
} as const;

const PREPARED_EXPIRED = { ...PREPARED_REQUIRED, confirmation: "expired" } as const;

function operationEnvelope(operation: unknown): Record<string, unknown> {
  return okEnvelope("status", { type: "operation", operation });
}

function client(http: FakeHttp, sleep: () => Promise<void>): Syndroo {
  return new Syndroo({ baseUrl: BASE_URL, apiKey: "sdk-test-key", fetch: http.fetch, sleep: () => sleep() });
}

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

describe("wait polls status only", () => {
  it("keeps polling while a delivery is unresolved, then returns the round", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: operationEnvelope(EXECUTION_UNKNOWN_WITH_OPEN_DELIVERY) },
      { kind: "json", status: 200, body: operationEnvelope(EXECUTION_SUCCEEDED) },
    ]);
    let sleeps = 0;
    const syndroo = client(http, async () => {
      sleeps += 1;
    });

    const round = await syndroo.wait("op_1", { intervalMs: 250, timeoutMs: 5000 });

    expect(round.status).toBe("succeeded");
    expect(sleeps).toBe(1);
    expect(http.callCount).toBe(2);
    for (const request of http.requests) {
      expect(request.method).toBe("POST");
      expect(request.url).toBe(`${BASE_URL}/v1/status`);
      expect(JSON.parse(request.body)).toEqual({ type: "operation", operationId: "op_1" });
    }
    expect(http.requests.some((request) => request.url.endsWith("/v1/publish"))).toBe(false);
  });

  it("does not treat an aggregate unknown as round completion", () => {
    const blocked = EXECUTION_UNKNOWN_WITH_OPEN_DELIVERY as unknown as ExecutionResult;
    expect(isExecutionRoundComplete(blocked)).toBe(false);
    expect(isExecutionRoundComplete(EXECUTION_SUCCEEDED as unknown as ExecutionResult)).toBe(true);
  });

  it("throws CONFIRMATION_REQUIRED for a prepared operation", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: operationEnvelope(PREPARED_REQUIRED) },
    ]);
    const error = await errorOf(() => client(http, async () => {}).wait("op_1", { timeoutMs: 1000 }));
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(http.callCount).toBe(1);
  });

  it("throws CONFIRMATION_EXPIRED for an expired prepared operation", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: operationEnvelope(PREPARED_EXPIRED) },
    ]);
    const error = await errorOf(() => client(http, async () => {}).wait("op_1", { timeoutMs: 1000 }));
    expect(error.code).toBe("CONFIRMATION_EXPIRED");
  });

  it("rejects an empty operation id without polling", async () => {
    const http = new FakeHttp([]);
    const error = await errorOf(() => client(http, async () => {}).wait(""));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(http.callCount).toBe(0);
  });
});

describe("wait bounds", () => {
  it.each([
    { intervalMs: WAIT_LIMITS.minIntervalMs - 1 },
    { intervalMs: WAIT_LIMITS.maxIntervalMs + 1 },
    { timeoutMs: 0 },
    { timeoutMs: WAIT_LIMITS.maxTimeoutMs + 1 },
  ])("rejects %j before polling", async (options) => {
    const http = new FakeHttp([]);
    const error = await errorOf(() => client(http, async () => {}).wait("op_1", options));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(http.callCount).toBe(0);
  });

  it("applies the documented defaults", () => {
    expect(WAIT_LIMITS.defaultIntervalMs).toBe(2000);
    expect(WAIT_LIMITS.defaultTimeoutMs).toBe(120000);
    expect(WAIT_LIMITS.maxTimeoutMs).toBe(3600000);
  });
});

describe("wait deadline and cancellation", () => {
  it("times out without publishing when the round never completes", async () => {
    let clock = 0;
    let reads = 0;
    const round = EXECUTION_PENDING as unknown as OperationView;
    const error = await errorOf(() =>
      waitForExecutionRound(
        {
          readOperation: async () => {
            reads += 1;
            return round;
          },
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
        "op_1",
        { intervalMs: 2000, timeoutMs: 3000 },
      ),
    );
    expect(error.code).toBe("WAIT_TIMEOUT");
    // The deadline is checked before each poll, so the loop stops at the
    // deadline instead of asking the server once more past it.
    expect(reads).toBe(2);
    expect(clock).toBe(3000);
  });

  it("abandons a slow in-flight poll at the budget instead of returning late", async () => {
    // No injected clock and no injected sleep: a real timer must fire while the
    // status request is still in flight. The poll would answer at 50 ms with a
    // complete round, which is exactly what must not be returned at 50 ms.
    const http = new FakeHttp([
      {
        kind: "slow",
        status: 200,
        body: operationEnvelope(EXECUTION_SUCCEEDED),
        delayMs: 50,
      },
    ]);
    const syndroo = new Syndroo({ baseUrl: BASE_URL, apiKey: "sdk-test-key", fetch: http.fetch });
    const started = Date.now();
    const error = await errorOf(() => syndroo.wait("op_1", { intervalMs: 250, timeoutMs: 5 }));
    const elapsed = Date.now() - started;
    expect(error.code).toBe("WAIT_TIMEOUT");
    expect(elapsed).toBeLessThan(50);
    expect(http.callCount).toBe(1);
  });

  it("stops an aborted wait without polling", async () => {
    const http = new FakeHttp([]);
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(() =>
      client(http, async () => {}).wait("op_1", { signal: controller.signal }),
    );
    expect(error.code).toBe("ABORTED");
    expect(http.callCount).toBe(0);
  });

  it("stops an aborted wait between polls", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: operationEnvelope(EXECUTION_PENDING) },
    ]);
    const controller = new AbortController();
    const error = await errorOf(() =>
      client(http, async () => {
        controller.abort();
      }).wait("op_1", { signal: controller.signal, timeoutMs: 5000 }),
    );
    expect(error.code).toBe("ABORTED");
    expect(http.callCount).toBe(1);
  });
});
