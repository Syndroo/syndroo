/**
 * Public `Syndroo` surface: request/result correlation, narrowed returns and
 * request-identity rules. The "typed" assertions are compiled by
 * `tsconfig.test.json`, so a wrong return type fails `npm run check`.
 */

import { describe, expect, it } from "vitest";

import { Syndroo, SyndrooError } from "../src/index.js";
import type {
  ConnectResult,
  ConnectionView,
  DoneConnectResult,
  ExecutionResult,
  OperationSummary,
  ProviderView,
  PublishResult,
} from "../src/index.js";
import { FakeHttp } from "./support/fake-http.js";
import {
  CONNECT_ACTION_REQUIRED,
  CONNECTION_DONE,
  EXECUTION_SUCCEEDED,
  PREPARED,
  STATUS_CONNECTIONS,
  STATUS_OPERATION,
  STATUS_OPERATIONS,
  STATUS_OVERVIEW,
  STATUS_PROVIDER,
  errorEnvelope,
  okEnvelope,
} from "./support/wire-fixtures.js";

const BASE_URL = "https://syndroo.example";

function client(http: FakeHttp): Syndroo {
  return new Syndroo({ baseUrl: BASE_URL, apiKey: "sdk-test-key", fetch: http.fetch });
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

describe("connect", () => {
  it("returns an action_required step for a start", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECT_ACTION_REQUIRED) },
    ]);
    const result: ConnectResult = await client(http).connect({
      type: "start",
      provider: "bluesky",
    });
    expect(result.status).toBe("action_required");
  });

  it("narrows an update to a done result", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECTION_DONE) },
    ]);
    const result: DoneConnectResult = await client(http).connect({
      type: "update",
      connectionId: "conn_1",
      changes: { label: "mine" },
    });
    expect(result.connection.connectionId).toBe("conn_1");
  });

  it("narrows a disconnect to a done result", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECTION_DONE) },
    ]);
    const result: DoneConnectResult = await client(http).connect({
      type: "disconnect",
      connectionId: "conn_1",
    });
    expect(result.status).toBe("done");
  });

  it("fails safe when an update does not end in a bound connection", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECT_ACTION_REQUIRED) },
    ]);
    const error = await errorOf(() =>
      client(http).connect({ type: "update", connectionId: "conn_1", changes: {} }),
    );
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("does not require request identity for a resume", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECTION_DONE) },
    ]);
    await client(http).connect({
      type: "resume",
      connectSessionId: "cs_1",
      stepRevision: 1,
      input: { type: "callback_complete" },
    });
    expect(http.requests[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("requires request identity for a start", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECT_ACTION_REQUIRED) },
    ]);
    await client(http).connect({ type: "start", provider: "bluesky" });
    expect(http.requests[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("does not promise a bound connection for a start", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("connect", CONNECT_ACTION_REQUIRED) },
    ]);
    const started: ConnectResult = await client(http).connect({
      type: "start",
      provider: "bluesky",
    });
    expect(started.status).toBe("action_required");
    // Only update/disconnect narrow to `done`; a start can end in
    // `action_required`, so reading `connection` off a start must not compile.
    // The closure is never called; `npm run check` is what runs the assertion,
    // and an unused `@ts-expect-error` (which is what an over-broad `done`
    // overload would produce) fails the check.
    const readConnectionId = async (): Promise<string> => {
      const result = await client(http).connect({ type: "start", provider: "bluesky" });
      // @ts-expect-error a start is not guaranteed to answer with a bound connection
      return result.connection.connectionId;
    };
    expect(readConnectionId).toBeTypeOf("function");
  });
});

describe("publish", () => {
  it("returns a prepared result for prepare", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const result: PublishResult = await client(http).publish({
      type: "prepare",
      content: { text: "hello" },
      targets: [{ provider: "bluesky" }],
    });
    expect(result.status).toBe("confirmation_required");
    expect(http.requests[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("returns an execution result for execute and sends no idempotency key", async () => {
    // A terminal execution is a completed protocol answer, so the server sends
    // 200; 202 is reserved for an admitted, still-running execution.
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", EXECUTION_SUCCEEDED) },
    ]);
    const result: ExecutionResult = await client(http).publish({
      type: "execute",
      approvalToken: "approval_1",
    });
    expect(result.phase).toBe("execution");
    expect(result.status).toBe("succeeded");
    expect(http.requests[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("lets a retry replay an already admitted execution", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", EXECUTION_SUCCEEDED) },
    ]);
    const result: PublishResult = await client(http).publish({
      type: "retry",
      retryOf: "op_1",
      targets: [{ provider: "bluesky", connection: "conn_1" }],
    });
    expect(result.status).toBe("succeeded");
    expect(http.requests[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("fails safe when execute does not answer with an execution round", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    const error = await errorOf(() =>
      client(http).publish({ type: "execute", approvalToken: "approval_1" }),
    );
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("reuses a caller-supplied idempotency key verbatim", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("publish", PREPARED) },
    ]);
    await client(http).publish(
      { type: "prepare", content: { text: "hello" }, targets: [{ provider: "bluesky" }] },
      { idempotencyKey: "req_abc" },
    );
    expect(http.requests[0]?.headers["idempotency-key"]).toBe("req_abc");
  });
});

describe("status", () => {
  it("types all five query results", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_OVERVIEW) },
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_PROVIDER) },
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_CONNECTIONS) },
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_OPERATION) },
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_OPERATIONS) },
    ]);
    const syndroo = client(http);

    const overview: {
      type: "overview";
      initialized: boolean;
      connectionCount: number;
      stateHealth: "ok" | "recovery_required";
    } = await syndroo.status({ type: "overview" });
    expect(overview.initialized).toBe(true);

    const provider: { type: "provider"; provider: ProviderView } = await syndroo.status({
      type: "provider",
      provider: "bluesky",
    });
    expect(provider.provider.provider).toBe("bluesky");

    const connections: { type: "connections"; connections: readonly ConnectionView[] } =
      await syndroo.status({ type: "connections" });
    expect(connections.connections).toEqual([]);

    const operation: { type: "operation"; operation: { phase: "execution" | "prepared" } } =
      await syndroo.status({ type: "operation", operationId: "op_1" });
    expect(operation.operation.phase).toBe("execution");

    const operations: {
      type: "operations";
      operations: readonly OperationSummary[];
    } = await syndroo.status({ type: "operations", limit: 20 });
    expect(operations.operations).toEqual([]);

    expect(http.callCount).toBe(5);
  });

  it("sends no idempotency key for a query", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_CONNECTIONS) },
    ]);
    await client(http).status({ type: "connections" });
    expect(http.requests[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("fails safe when the result does not answer the query that was asked", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 200, body: okEnvelope("status", STATUS_PROVIDER) },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  it("surfaces a protocol rejection envelope as a static error", async () => {
    const http = new FakeHttp([
      { kind: "json", status: 401, body: errorEnvelope("status", "UNAUTHORIZED") },
    ]);
    const error = await errorOf(() => client(http).status({ type: "connections" }));
    expect(error.code).toBe("PROTOCOL");
    expect(error.serverError?.code).toBe("UNAUTHORIZED");
    expect(error.message).not.toContain("sdk-test-key");
    expect(error.message).not.toContain(BASE_URL);
  });
});
