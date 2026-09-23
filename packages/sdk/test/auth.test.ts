/**
 * The public auth facade: exact method, path, body, authorization, and call
 * count for every operation, plus the identity, revision, and safety rules the
 * boundary document requires.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyndrooApiError,
  SyndrooClient,
  SyndrooConfigError,
  SyndrooError,
  SyndrooResponseError,
  SyndrooValidationError,
  type AuthStatus,
  type PlatformStatus,
  type SyndrooClientOptions,
} from "../src/index.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const BASE_URL = "https://syndroo.example.com";
const SENTINEL = "SENTINEL_SECRET_VALUE_9f3a";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly authorization: string | undefined;
}

const calls: Call[] = [];

function stubFetch(handler: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      };

      calls.push(call);
      return Promise.resolve(handler(call));
    },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PLATFORM_STATUS = {
  platform: "bluesky",
  configured: true,
  source: "credential",
  oauthSupported: false,
  readiness: "ready",
  missingFields: [],
  expiresAt: null,
  revision: 3,
  target: { label: "alice.bsky.social", source: "user" },
};

const AUTH_STATUS = {
  instance: { publishingReady: true, missingFields: [] },
  platforms: { bluesky: PLATFORM_STATUS },
};

const COMPLETE_RECEIPT = {
  platform: "linkedin",
  operationId: "op_1",
  stored: true,
  revision: 4,
  configured: true,
  readiness: "ready",
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

function bodyOf(index = 0): Record<string, unknown> {
  const call = calls[index];

  if (call === undefined || call.body === "") {
    throw new Error(`No JSON body was sent on call ${index}.`);
  }

  return JSON.parse(call.body) as Record<string, unknown>;
}

/** Everything an error exposes: message, cause, preview, enumerable fields, stack. */
function serialized(error: unknown): string {
  const failure = error as {
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
    preview?: unknown;
  };

  return [
    String(failure.message),
    String(failure.stack),
    JSON.stringify(error),
    String(failure.cause),
    String(failure.preview),
  ].join("\n");
}

describe("auth.status", () => {
  it("lists every platform plus instance readiness from GET /v1/auth", async () => {
    stubFetch(() => json(200, AUTH_STATUS));

    const status = await client().auth.status();

    expect(status).toEqual(AUTH_STATUS);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth`);
    expect(calls[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.body).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("reads one platform and checks the answered identity", async () => {
    stubFetch(() => json(200, PLATFORM_STATUS));

    const status = await client().auth.status("bluesky");

    expect(status.platform).toBe("bluesky");
    expect(status.revision).toBe(3);
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/bluesky`);
    expect(calls).toHaveLength(1);
  });

  it("rejects a status that answers about another platform", async () => {
    stubFetch(() => json(200, { ...PLATFORM_STATUS, platform: "threads" }));

    const error = expectSdkError(await captured(client().auth.status("bluesky")));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.operation).toBe("auth.status");
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(error.message).toContain("different platform");
  });

  it("projects unknown fields away and keeps documented ones", async () => {
    stubFetch(() =>
      json(200, {
        ...PLATFORM_STATUS,
        secretExtra: SENTINEL,
        target: { label: "alice", source: "user", extra: SENTINEL },
      }),
    );

    const status = await client().auth.status("bluesky");

    expect(Object.keys(status).sort()).toEqual([
      "configured",
      "expiresAt",
      "missingFields",
      "oauthSupported",
      "platform",
      "readiness",
      "revision",
      "source",
      "target",
    ]);
    expect(JSON.stringify(status)).not.toContain(SENTINEL);
  });

  it("reports an unknown readiness as a contract failure without echoing it", async () => {
    stubFetch(() => json(200, { ...PLATFORM_STATUS, readiness: SENTINEL }));

    const error = expectSdkError(await captured(client().auth.status("bluesky")));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).toContain("documented values");
    expect(error.message).not.toContain(SENTINEL);
    expect(error.message).toContain("0.5.0 auth API");
  });
});

describe("auth mutations send exactly one guarded request", () => {
  it("sets direct credentials with the observed revision", async () => {
    stubFetch(() =>
      json(200, {
        platform: "bluesky",
        stored: true,
        revision: 4,
        configured: true,
        readiness: "ready",
      }),
    );

    const receipt = await client().auth.set(
      "bluesky",
      { identifier: "alice.bsky.social", password: "app-password", host: "bsky.social" },
      { expectedRevision: 3 },
    );

    expect(receipt.stored).toBe(true);
    expect(receipt.revision).toBe(4);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/bluesky`);
    expect(bodyOf()).toEqual({
      identifier: "alice.bsky.social",
      password: "app-password",
      host: "bsky.social",
      expectedRevision: 3,
    });
    expect(calls).toHaveLength(1);
  });

  it("connects with the observed revision and checks the echoed revision", async () => {
    stubFetch(() =>
      json(200, {
        platform: "x",
        operationId: "op_1",
        url: "https://provider.example/authorize?state=abc",
        expiresAt: "2030-01-02T03:04:05.000Z",
        expectedRevision: 7,
      }),
    );

    const receipt = await client().auth.connect("x", { expectedRevision: 7 });

    expect(receipt.operationId).toBe("op_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/x/connect`);
    expect(bodyOf()).toEqual({ expectedRevision: 7 });
  });

  it("rejects a connect receipt that echoes a different revision", async () => {
    stubFetch(() =>
      json(200, {
        platform: "x",
        operationId: "op_1",
        url: "https://provider.example/authorize",
        expiresAt: "2030-01-02T03:04:05.000Z",
        expectedRevision: 8,
      }),
    );

    const error = expectSdkError(
      await captured(client().auth.connect("x", { expectedRevision: 7 })),
    );

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.operation).toBe("auth.connect");
    expect(error.requestMayHaveBeenApplied).toBe(true);
  });

  it("reads one operation by its encoded id", async () => {
    stubFetch(() =>
      json(200, {
        platform: "tumblr",
        operationId: "op/1",
        phase: "awaiting_confirmation",
        expiresAt: "2030-01-02T03:04:05.000Z",
        expectedRevision: 2,
        missingFields: ["blog"],
        candidate: { target: { label: "alice.tumblr.com", source: "provider" } },
        active: { ...PLATFORM_STATUS, platform: "tumblr" },
      }),
    );

    const status = await client().auth.operation("tumblr", "op/1");

    expect(status.phase).toBe("awaiting_confirmation");
    expect(status.candidate?.target?.source).toBe("provider");
    expect(status.active.platform).toBe("tumblr");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/tumblr/operations/op%2F1`);
  });

  it("keeps candidate and active separate", async () => {
    stubFetch(() =>
      json(200, {
        platform: "linkedin",
        operationId: "op_1",
        phase: "awaiting_confirmation",
        expiresAt: "2030-01-02T03:04:05.000Z",
        expectedRevision: 1,
        missingFields: [],
        candidate: { target: { label: "urn:li:person:new", source: "user" } },
        active: {
          ...PLATFORM_STATUS,
          platform: "linkedin",
          target: { label: "urn:li:person:old", source: "user" },
        },
      }),
    );

    const status = await client().auth.operation("linkedin", "op_1");

    expect(status.candidate?.target?.label).toBe("urn:li:person:new");
    expect(status.active.target?.label).toBe("urn:li:person:old");
  });

  it("completes with a LinkedIn target and returns the receipt", async () => {
    stubFetch(() => json(200, COMPLETE_RECEIPT));

    const receipt = await client().auth.complete("linkedin", "op_1", {
      expectedRevision: 3,
      target: { author: "urn:li:person:alice", api_version: "202604" },
    });

    expect(receipt.stored).toBe(true);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/linkedin/operations/op_1/complete`);
    expect(bodyOf()).toEqual({
      expectedRevision: 3,
      target: { author: "urn:li:person:alice", api_version: "202604" },
    });
  });

  it("returns a replayed completion receipt unchanged", async () => {
    stubFetch(() => json(200, { ...COMPLETE_RECEIPT, replayed: true, revision: 2 }));

    const receipt = await client().auth.complete("linkedin", "op_1", {
      expectedRevision: 3,
      target: { author: "urn:li:person:alice", api_version: "202604" },
    });

    expect(receipt.replayed).toBe(true);
    expect(receipt.revision).toBe(2);
  });

  it("refreshes with the observed revision", async () => {
    stubFetch(() =>
      json(200, {
        platform: "threads",
        refreshed: true,
        revision: 9,
        configured: true,
        readiness: "ready",
        expiresAt: "2030-02-02T03:04:05.000Z",
      }),
    );

    const receipt = await client().auth.refresh("threads", { expectedRevision: 8 });

    expect(receipt.refreshed).toBe(true);
    expect(receipt.expiresAt).toBe("2030-02-02T03:04:05.000Z");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/threads/refresh`);
    expect(bodyOf()).toEqual({ expectedRevision: 8 });
  });

  it("removes with DELETE and the observed revision", async () => {
    stubFetch(() =>
      json(200, {
        platform: "bluesky",
        removed: true,
        revision: 5,
        configured: false,
        readiness: "missing_credentials",
      }),
    );

    const receipt = await client().auth.remove("bluesky", { expectedRevision: 4 });

    expect(receipt.removed).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/auth/bluesky`);
    expect(bodyOf()).toEqual({ expectedRevision: 4 });
  });
});

describe("auth argument validation happens before any request", () => {
  it("requires an explicitly observed revision on every mutation", async () => {
    const missingRevision: ReadonlyArray<(syndroo: SyndrooClient) => Promise<unknown>> = [
      (syndroo) =>
        syndroo.auth.set(
          "bluesky",
          { identifier: "alice", password: "pw" },
          {} as { expectedRevision: number },
        ),
      (syndroo) => syndroo.auth.connect("x", {} as { expectedRevision: number }),
      (syndroo) =>
        syndroo.auth.complete("tumblr", "op_1", {} as { expectedRevision: number }),
      (syndroo) => syndroo.auth.refresh("threads", {} as { expectedRevision: number }),
      (syndroo) => syndroo.auth.remove("bluesky", {} as { expectedRevision: number }),
    ];

    for (const run of missingRevision) {
      stubFetch(() => json(200, {}));

      const error = expectSdkError(await captured(run(client())));

      expect(error).toBeInstanceOf(SyndrooValidationError);
      expect(error.message).toContain("expectedRevision");
      expect(error.requestMayHaveBeenApplied).toBe(false);
    }

    expect(calls).toEqual([]);
  });

  it("rejects invalid revisions before any request", async () => {
    for (const expectedRevision of [0.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      stubFetch(() => json(200, {}));

      const error = expectSdkError(
        await captured(
          client().auth.remove("bluesky", {
            expectedRevision: expectedRevision as unknown as number,
          }),
        ),
      );

      expect(error).toBeInstanceOf(SyndrooValidationError);
      expect(error.message).toContain("expectedRevision");
    }

    expect(calls).toEqual([]);
  });

  it("rejects app-secret and control fields inside a credential object", async () => {
    const cases: ReadonlyArray<{ platform: string; credential: Record<string, string> }> = [
      {
        platform: "x",
        credential: { access_token: "t", access_token_secret: "s", X_API_KEY: SENTINEL },
      },
      {
        platform: "bluesky",
        credential: { identifier: "a", password: "p", expectedRevision: "2" },
      },
      {
        platform: "bluesky",
        credential: { identifier: "a", password: "p", unexpected: SENTINEL },
      },
    ];

    for (const testCase of cases) {
      stubFetch(() => json(200, {}));

      const error = expectSdkError(
        await captured(
          client().auth.set(testCase.platform, testCase.credential, { expectedRevision: 1 }),
        ),
      );

      expect(error).toBeInstanceOf(SyndrooValidationError);
      expect(error.message).not.toContain(SENTINEL);
    }

    expect(calls).toEqual([]);
  });

  it("rejects a missing required credential field", async () => {
    stubFetch(() => json(200, {}));

    const error = expectSdkError(
      await captured(client().auth.set("tumblr", { token: "t" }, { expectedRevision: 1 })),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.message).toContain("token_secret");
    expect(calls).toEqual([]);
  });

  it("survives a credential whose getter throws, with zero calls", async () => {
    const credential = {
      get identifier(): string {
        throw new Error(`getter ${SENTINEL}`);
      },
      password: "pw",
    };
    stubFetch(() => json(200, {}));

    const error = expectSdkError(
      await captured(client().auth.set("bluesky", credential, { expectedRevision: 1 })),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.message).not.toContain(SENTINEL);
    expect(calls).toEqual([]);
  });

  it("rejects a JSON __proto__ credential instead of inheriting its fields", async () => {
    // A plain `{}` snapshot would route this key through the prototype setter,
    // hiding the unknown key and satisfying `access_token` by inheritance.
    const credential = JSON.parse(
      `{"__proto__":{"access_token":"fake-sentinel"}}`,
    ) as Record<string, string>;
    stubFetch(() => json(200, {}));

    const error = expectSdkError(
      await captured(client().auth.set("linkedin", credential, { expectedRevision: 0 })),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.operation).toBe("auth.set");
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(serialized(error)).not.toContain("fake-sentinel");
    expect(calls).toEqual([]);
  });

  it("rejects a JSON __proto__ target instead of inheriting its fields", async () => {
    const target = JSON.parse(
      `{"__proto__":{"blog":"fake-sentinel"}}`,
    ) as Record<string, string>;
    stubFetch(() => json(200, COMPLETE_RECEIPT));

    const error = expectSdkError(
      await captured(
        client().auth.complete("tumblr", "op_1", { expectedRevision: 1, target }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(serialized(error)).not.toContain("fake-sentinel");
    expect(calls).toEqual([]);
  });

  it("does not accept a required credential field that is only inherited", async () => {
    const credential = Object.create({
      identifier: "inherited",
      password: "inherited",
    }) as Record<string, string>;
    stubFetch(() => json(200, {}));

    const error = expectSdkError(
      await captured(client().auth.set("bluesky", credential, { expectedRevision: 0 })),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.message).toContain("identifier");
    expect(calls).toEqual([]);
  });

  it("reports an inherited-only platform table lookup as a controlled error", async () => {
    // `DIRECT_CREDENTIAL_FIELDS["constructor"]` is an inherited function, not a
    // field spec: the lookup must not produce a raw TypeError.
    stubFetch(() => json(200, {}));

    const error = expectSdkError(
      await captured(
        client().auth.set("constructor", {}, { expectedRevision: 0 }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.operation).toBe("auth.set");
    expect(error.requestMayHaveBeenApplied).toBe(false);

    expect(calls).toEqual([]);
  });

  it("rejects target keys for a platform with no documented schema", async () => {
    stubFetch(() => json(200, {}));

    const error = expectSdkError(
      await captured(
        client().auth.complete("constructor", "op_1", {
          expectedRevision: 0,
          target: { blog: "alice" },
        }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.operation).toBe("auth.complete");
    expect(calls).toEqual([]);
  });

  it("still allows an unexpected platform name on reads", async () => {
    stubFetch(() => json(200, { ...PLATFORM_STATUS, platform: "constructor" }));

    const status = await client().auth.status("constructor");

    expect(status.platform).toBe("constructor");
    expect(calls).toHaveLength(1);
  });

  it("rejects target keys the selected platform does not document", async () => {
    const cases: ReadonlyArray<{ platform: string; target: Record<string, string> }> = [
      { platform: "x", target: { blog: "alice" } },
      { platform: "tumblr", target: { author: "urn:li:person:a" } },
      { platform: "linkedin", target: { blog: "alice" } },
      { platform: "tumblr", target: { blog: "alice", extra: SENTINEL } },
    ];

    for (const testCase of cases) {
      stubFetch(() => json(200, COMPLETE_RECEIPT));

      const error = expectSdkError(
        await captured(
          client().auth.complete(testCase.platform, "op_1", {
            expectedRevision: 1,
            target: testCase.target,
          }),
        ),
      );

      expect(error).toBeInstanceOf(SyndrooValidationError);
      expect(error.message).not.toContain(SENTINEL);
    }

    expect(calls).toEqual([]);
  });

  it("rejects invalid LinkedIn target values before any request", async () => {
    for (const target of [
      { author: "alice", api_version: "202604" },
      { author: "urn:li:person:alice", api_version: "2026" },
      { author: "urn:li:person:alice", api_version: "202613" },
    ]) {
      stubFetch(() => json(200, COMPLETE_RECEIPT));

      const error = expectSdkError(
        await captured(
          client().auth.complete("linkedin", "op_1", { expectedRevision: 1, target }),
        ),
      );

      expect(error).toBeInstanceOf(SyndrooValidationError);
    }

    expect(calls).toEqual([]);
  });

  it("lets the server decide whether an unfinished operation still needs a target", async () => {
    stubFetch(() =>
      json(200, {
        platform: "linkedin",
        operationId: "op_1",
        stored: true,
        revision: 4,
        configured: true,
        readiness: "ready",
        replayed: true,
      }),
    );

    // A replay of a completed operation carries the historical receipt, so the
    // SDK must not demand a target locally.
    const receipt = await client().auth.complete("linkedin", "op_1", {
      expectedRevision: 4,
    });

    expect(receipt.replayed).toBe(true);
    expect(bodyOf()).toEqual({ expectedRevision: 4 });
  });

  it("sends a partial LinkedIn target for the server to complete", async () => {
    stubFetch(() => json(200, COMPLETE_RECEIPT));

    await client().auth.complete("linkedin", "op_1", {
      expectedRevision: 3,
      target: { author: "urn:li:person:alice" },
    });

    expect(bodyOf()).toEqual({
      expectedRevision: 3,
      target: { author: "urn:li:person:alice" },
    });
  });

  it("rejects an unusable per-call duration before any request", async () => {
    stubFetch(() => json(200, AUTH_STATUS));

    const error = expectSdkError(await captured(client().auth.status({ timeoutMs: 0 })));

    expect(error).toBeInstanceOf(SyndrooConfigError);
    expect(error.operation).toBe("auth.status");
    expect(calls).toEqual([]);
  });
});

describe("auth failures keep status, ambiguity, and safe recovery text", () => {
  it("keeps a malformed 2xx mutation as an ambiguous write at its real status", async () => {
    const malformed: ReadonlyArray<(syndroo: SyndrooClient) => Promise<unknown>> = [
      (syndroo) =>
        syndroo.auth.set(
          "bluesky",
          { identifier: "a", password: "p" },
          { expectedRevision: 1 },
        ),
      (syndroo) => syndroo.auth.connect("x", { expectedRevision: 1 }),
      (syndroo) =>
        syndroo.auth.complete("tumblr", "op_1", {
          expectedRevision: 1,
          target: { blog: "alice" },
        }),
      (syndroo) => syndroo.auth.refresh("threads", { expectedRevision: 1 }),
      (syndroo) => syndroo.auth.remove("bluesky", { expectedRevision: 1 }),
    ];

    for (const run of malformed) {
      calls.length = 0;
      stubFetch(() => json(202, null));

      const error = expectSdkError(await captured(run(client())));

      expect(error).toBeInstanceOf(SyndrooResponseError);
      expect((error as SyndrooResponseError).status).toBe(202);
      expect(error.requestMayHaveBeenApplied).toBe(true);
      expect(error.operation).toMatch(/^auth\./u);
      expect(calls).toHaveLength(1);
    }
  });

  it("keeps a malformed 2xx read as a read", async () => {
    const reads: ReadonlyArray<(syndroo: SyndrooClient) => Promise<unknown>> = [
      (syndroo) => syndroo.auth.status(),
      (syndroo) => syndroo.auth.status("bluesky"),
      (syndroo) => syndroo.auth.operation("bluesky", "op_1"),
    ];

    for (const run of reads) {
      stubFetch(() => json(200, null));

      const error = expectSdkError(await captured(run(client())));

      expect(error).toBeInstanceOf(SyndrooResponseError);
      expect(error.requestMayHaveBeenApplied).toBe(false);
    }
  });

  it("never advises a new post key or an automatic refresh", async () => {
    const failures: ReadonlyArray<{
      status: number;
      code: string;
      run: (syndroo: SyndrooClient) => Promise<unknown>;
    }> = [
      {
        status: 409,
        code: "AUTH_CONFLICT",
        run: (syndroo) =>
          syndroo.auth.set(
            "bluesky",
            { identifier: "a", password: "p" },
            { expectedRevision: 1 },
          ),
      },
      {
        status: 409,
        code: "AUTH_IN_PROGRESS",
        run: (syndroo) => syndroo.auth.connect("x", { expectedRevision: 1 }),
      },
      {
        status: 503,
        code: "STORE_UNAVAILABLE",
        run: (syndroo) => syndroo.auth.refresh("threads", { expectedRevision: 1 }),
      },
      {
        status: 500,
        code: "INTERNAL_ERROR",
        run: (syndroo) => syndroo.auth.remove("bluesky", { expectedRevision: 1 }),
      },
    ];

    for (const failure of failures) {
      calls.length = 0;
      stubFetch(() =>
        json(failure.status, {
          error: { code: failure.code, message: `provider said ${SENTINEL}` },
        }),
      );

      const error = expectSdkError(await captured(failure.run(client())));

      expect(error).toBeInstanceOf(SyndrooApiError);
      expect(error.message).not.toContain("Idempotency-Key");
      expect(error.message).not.toContain("posts.list");
      expect(error.message).not.toContain(SENTINEL);
      expect(calls).toHaveLength(1);

      // A 4xx is a controlled rejection; a 5xx leaves the write uncertain and
      // must point at auth.status rather than at a post key.
      if (failure.status >= 500) {
        expect(error.message).toContain("auth.status");
      } else {
        expect(error.message).toContain("nothing was applied");
      }
    }
  });

  it("keeps one write on an aborted mutation", async () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = client().auth.set(
      "bluesky",
      { identifier: "a", password: "p" },
      { expectedRevision: 1, signal: controller.signal },
    );

    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();

    const error = expectSdkError(await captured(pending));

    expect(error.operation).toBe("auth.set");
    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(error.message).toContain("auth.status");
    expect(calls).toHaveLength(1);
  });

  it("reports a timed-out auth read as safe", async () => {
    stubFetch(() => new Promise<Response>(() => undefined));

    const error = expectSdkError(
      await captured(client({ timeoutMs: 40 }).auth.status("bluesky")),
    );

    expect(error.operation).toBe("auth.status");
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("auth wire types stay closed", () => {
  it("rejects a status whose revision is not a safe integer", async () => {
    stubFetch(() => json(200, { ...PLATFORM_STATUS, revision: -1 }));

    const error = expectSdkError(await captured(client().auth.status("bluesky")));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).toContain("revision");
  });

  it("rejects an undocumented missing-field name", async () => {
    stubFetch(() => json(200, { ...PLATFORM_STATUS, missingFields: [SENTINEL] }));

    const error = expectSdkError(await captured(client().auth.status("bluesky")));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).not.toContain(SENTINEL);
  });

  it("rejects an undocumented operation error code and keeps a documented one", async () => {
    const base = {
      platform: "bluesky",
      operationId: "op_1",
      phase: "failed",
      expiresAt: "2030-01-02T03:04:05.000Z",
      expectedRevision: 1,
      missingFields: [],
      active: PLATFORM_STATUS,
    };

    stubFetch(() => json(200, { ...base, errorCode: SENTINEL }));

    const error = expectSdkError(
      await captured(client().auth.operation("bluesky", "op_1")),
    );

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).not.toContain(SENTINEL);

    stubFetch(() => json(200, { ...base, errorCode: "PROVIDER_DENIED" }));

    const status = await client().auth.operation("bluesky", "op_1");

    expect(status.errorCode).toBe("PROVIDER_DENIED");
  });

  it("keeps the application's stored operation error codes and candidate fields", async () => {
    const base = {
      platform: "tumblr",
      operationId: "op_1",
      phase: "needs_configuration",
      expiresAt: "2030-01-02T03:04:05.000Z",
      expectedRevision: 2,
      // The operation's own list names the candidate fields it still needs.
      missingFields: ["blog"],
      candidate: {
        target: { label: "alice.tumblr.com", source: "provider" },
        // Unknown extras inside `candidate` are simply not projected.
        unknownExtra: SENTINEL,
      },
      active: { ...PLATFORM_STATUS, platform: "tumblr" },
      errorCode: "DECRYPTION_FAILED",
    };

    stubFetch(() => json(200, base));

    const status = await client().auth.operation("tumblr", "op_1");

    expect(status.phase).toBe("needs_configuration");
    expect(status.errorCode).toBe("DECRYPTION_FAILED");
    expect(status.missingFields).toEqual(["blog"]);
    expect(status.candidate?.target?.source).toBe("provider");
    expect(JSON.stringify(status)).not.toContain(SENTINEL);

    // A top-level requirement outside the closed allowlist is a contract failure.
    stubFetch(() =>
      json(200, { ...base, missingFields: [SENTINEL] }),
    );

    const error = expectSdkError(
      await captured(client().auth.operation("tumblr", "op_1")),
    );

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).not.toContain(SENTINEL);
  });

  it("rejects nested projections that disagree with the operation", async () => {
    const base = {
      platform: "bluesky",
      operationId: "op_1",
      phase: "failed",
      expiresAt: "2030-01-02T03:04:05.000Z",
      expectedRevision: 1,
      missingFields: [],
    };

    // active.platform disagrees with the top-level platform.
    stubFetch(() =>
      json(200, {
        ...base,
        active: { ...PLATFORM_STATUS, platform: "threads" },
      }),
    );

    const badActive = expectSdkError(
      await captured(client().auth.operation("bluesky", "op_1")),
    );

    expect(badActive).toBeInstanceOf(SyndrooResponseError);
    expect(badActive.message).toContain("active status");

    // receipt.operationId disagrees with the operation read.
    stubFetch(() =>
      json(200, {
        ...base,
        active: PLATFORM_STATUS,
        receipt: { ...COMPLETE_RECEIPT, platform: "bluesky", operationId: "op_2" },
      }),
    );

    const badReceipt = expectSdkError(
      await captured(client().auth.operation("bluesky", "op_1")),
    );

    expect(badReceipt).toBeInstanceOf(SyndrooResponseError);
    expect(badReceipt.message).toContain("receipt");
  });

  it("rejects a platform map key that would become an unsafe property", async () => {
    // `JSON.parse` (unlike an object literal) creates a real own `__proto__`
    // property, which is exactly the key the SDK must refuse.
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            instance: { publishingReady: true, missingFields: [] },
            platforms: {},
          }).replace('"platforms":{}', `"platforms":{"__proto__":${JSON.stringify({ ...PLATFORM_STATUS, platform: "__proto__" })}}`),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const error = expectSdkError(await captured(client().auth.status()));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).toContain("key this SDK does not accept");
  });

  it("accepts the binding key as a documented missing field", async () => {
    stubFetch(() =>
      json(200, {
        instance: { publishingReady: false, missingFields: ["SYNDROO_BINDING_KEY"] },
        platforms: {},
      }),
    );

    const status = await client().auth.status();

    expect(status.instance.missingFields).toEqual(["SYNDROO_BINDING_KEY"]);
  });

  it("accepts the documented LinkedIn refresh_token as an optional field", async () => {
    stubFetch(() =>
      json(200, {
        platform: "linkedin",
        stored: true,
        revision: 2,
        configured: true,
        readiness: "ready",
      }),
    );

    await client().auth.set(
      "linkedin",
      {
        access_token: "token",
        author: "urn:li:person:alice",
        api_version: "202604",
        refresh_token: "refresh",
      },
      { expectedRevision: 1 },
    );

    expect(bodyOf()).toEqual({
      access_token: "token",
      author: "urn:li:person:alice",
      api_version: "202604",
      refresh_token: "refresh",
      expectedRevision: 1,
    });
  });

  it("rejects a receipt expiry that is not a real UTC instant", async () => {
    const receipts: ReadonlyArray<{ label: string; run: (syndroo: SyndrooClient) => Promise<unknown> }> = [
      {
        label: "connect",
        run: (syndroo) => syndroo.auth.connect("x", { expectedRevision: 1 }),
      },
      {
        label: "operation",
        run: (syndroo) => syndroo.auth.operation("bluesky", "op_1"),
      },
    ];

    for (const receipt of receipts) {
      for (const expiresAt of ["1", "2026-02-30T00:00:00.000Z", "2030-01-02T03:04:05Z"]) {
        if (receipt.label === "connect") {
          stubFetch(() =>
            json(200, {
              platform: "x",
              operationId: "op_1",
              url: "https://provider.example/authorize",
              expiresAt,
              expectedRevision: 1,
            }),
          );
        } else {
          stubFetch(() =>
            json(200, {
              platform: "bluesky",
              operationId: "op_1",
              phase: "pending_callback",
              expiresAt,
              expectedRevision: 1,
              missingFields: [],
              active: PLATFORM_STATUS,
            }),
          );
        }

        const error = expectSdkError(await captured(receipt.run(client())));

        expect(error).toBeInstanceOf(SyndrooResponseError);
        expect(error.operation).toBe(
          receipt.label === "connect" ? "auth.connect" : "auth.operation",
        );
        // A malformed write receipt stays ambiguous; the read does not.
        expect(error.requestMayHaveBeenApplied).toBe(receipt.label === "connect");
      }
    }
  });
});
