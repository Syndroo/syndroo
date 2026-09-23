/**
 * The transport boundary: one deadline over headers and body, no retries, no
 * raw values in any SDK-generated error, and closed allowlists for the codes
 * the SDK is willing to repeat.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooClient,
  SyndrooConfigError,
  SyndrooError,
  SyndrooNetworkError,
  SyndrooResponseError,
  SyndrooTimeoutError,
  SyndrooValidationError,
  SyndrooWaitTimeoutError,
  type SyndrooClientOptions,
} from "../src/index.js";
import { sendRequest, type TransportConfig } from "../src/http.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const BASE_URL = "https://syndroo.example.com";
const SENTINEL = "SENTINEL_SECRET_VALUE_9f3a";

const CONFIG: TransportConfig = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  timeoutMs: 5_000,
  maxResponseBytes: 8 * 1024 * 1024,
};

const calls: Array<{ method: string; url: string; init: RequestInit }> = [];

function stubFetch(handler: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method ?? "GET", url: String(input), init: init ?? {} });
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms.`);
    }

    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * A response whose body counts reads and cancellations. `Response` cannot
 * express "same buffer every read", so tests that need to observe disposal use
 * this stand-in instead.
 */
function fakeResponse(
  status: number,
  handlers: {
    onRead?: (() => void) | undefined;
    onCancel?: (() => void) | undefined;
    onRelease?: (() => void) | undefined;
    parts?: string[] | undefined;
    /** Rejects every read, the way a broken stream would. */
    readError?: unknown;
    /** Never settles a read or a cancel, the way a hung reader would. */
    hang?: boolean | undefined;
  } = {},
): Response {
  const encoder = new TextEncoder();
  const parts = handlers.parts ?? ["[]"];
  let index = 0;

  const reader = {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
      handlers.onRead?.();

      if (handlers.hang === true) {
        return new Promise<never>(() => undefined);
      }

      if (handlers.readError !== undefined) {
        return Promise.reject(handlers.readError);
      }

      const part = parts[index];
      index += 1;

      if (part === undefined) {
        return Promise.resolve({ done: true, value: undefined });
      }

      return Promise.resolve({ done: false, value: encoder.encode(part) });
    },
    releaseLock(): void {
      handlers.onRelease?.();
    },
    cancel(): Promise<void> {
      handlers.onCancel?.();

      if (handlers.hang === true) {
        return new Promise<never>(() => undefined);
      }

      return Promise.resolve();
    },
  };

  return {
    status,
    ok: status >= 200 && status < 300,
    type: "basic",
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader: () => reader,
      cancel: () => {
        handlers.onCancel?.();
        return Promise.resolve();
      },
    },
  } as unknown as Response;
}

describe("request outcomes keep the status and the write flag", () => {
  const cases: ReadonlyArray<{ status: number; code: string; applied: boolean }> = [
    { status: 400, code: "INVALID_REQUEST", applied: false },
    { status: 409, code: "IDEMPOTENCY_CONFLICT", applied: false },
    { status: 429, code: "RATE_LIMITED", applied: false },
    { status: 500, code: "INTERNAL_ERROR", applied: true },
    { status: 503, code: "SERVICE_UNAVAILABLE", applied: true },
  ];

  for (const testCase of cases) {
    it(`reports HTTP ${testCase.status} ${testCase.code} with one write and no retry`, async () => {
      stubFetch(() =>
        json(testCase.status, {
          error: { code: testCase.code, message: "server text" },
        }),
      );

      const error = expectSdkError(
        await captured(
          client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
        ),
      );

      expect(error).toBeInstanceOf(SyndrooApiError);
      expect((error as SyndrooApiError).status).toBe(testCase.status);
      expect(error.requestMayHaveBeenApplied).toBe(testCase.applied);
      expect(calls).toHaveLength(1);
    });
  }

  it("never marks a read as applied, even on a 5xx", async () => {
    stubFetch(() =>
      json(500, { error: { code: "INTERNAL_ERROR", message: "server text" } }),
    );

    const error = expectSdkError(await captured(client().posts.get("post_1")));

    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("redirects stay manual", () => {
  it("refuses a redirect, reports false, and keeps authorization local", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/v1/posts?token=${SENTINEL}` },
        }),
    );

    const error = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooApiError);
    expect((error as SyndrooApiError).code).toBe("REDIRECT_NOT_FOLLOWED");
    expect((error as SyndrooApiError).status).toBe(302);
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls).toHaveLength(1);
    expect(serialized(error)).not.toContain(SENTINEL);
  });
});

describe("abort and deadline", () => {
  it("sends nothing when the signal was already aborted", async () => {
    stubFetch(() => json(202, { id: "post_1", status: "queued" }));
    const controller = new AbortController();
    controller.abort();

    const error = expectSdkError(
      await captured(
        client().posts.create(
          { content: "Never sent", platforms: ["bluesky"] },
          { signal: controller.signal },
        ),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooAbortError);
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(calls).toEqual([]);
  });

  it("settles a hostile fetch that ignores AbortSignal at the deadline", async () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    const startedAt = Date.now();

    const error = expectSdkError(
      await captured(client({ timeoutMs: 60 }).posts.get("post_1")),
    );

    expect(error).toBeInstanceOf(SyndrooTimeoutError);
    expect((error as SyndrooTimeoutError).timeoutMs).toBe(60);
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  it("bounds a stalled body and cancels the losing read", async () => {
    let cancelled = 0;

    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Never produces a byte.
            },
            cancel() {
              cancelled += 1;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const error = expectSdkError(
      await captured(client({ timeoutMs: 60 }).posts.list()),
    );

    expect(error).toBeInstanceOf(SyndrooTimeoutError);
    await waitFor(() => cancelled > 0);
    expect(cancelled).toBeGreaterThan(0);
  });

  it("disposes a late response without reading it", async () => {
    let reads = 0;
    let cancels = 0;

    vi.stubGlobal("fetch", () =>
      new Promise<Response>(resolve => {
        // Answers well after the deadline, the way a slow proxy would.
        setTimeout(() => {
          resolve(
            fakeResponse(200, {
              onRead: () => {
                reads += 1;
              },
              onCancel: () => {
                cancels += 1;
              },
            }),
          );
        }, 80);
      }),
    );

    const error = expectSdkError(
      await captured(client({ timeoutMs: 40 }).posts.list()),
    );

    expect(error).toBeInstanceOf(SyndrooTimeoutError);
    await waitFor(() => cancels > 0);
    expect(reads).toBe(0);
    expect(cancels).toBe(1);
  });

  it("settles at the deadline when the reader and its cancel both hang", async () => {
    let cancels = 0;
    let releases = 0;
    const startedAt = Date.now();

    stubFetch(() =>
      fakeResponse(200, {
        hang: true,
        onCancel: () => {
          cancels += 1;
        },
        onRelease: () => {
          releases += 1;
        },
      }),
    );

    const error = expectSdkError(
      await captured(client({ timeoutMs: 40 }).posts.list()),
    );

    expect(error).toBeInstanceOf(SyndrooTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // The abandoned read was cancelled and its lock released without waiting
    // for either to settle.
    expect(cancels).toBeGreaterThan(0);
    expect(releases).toBeGreaterThan(0);
  });
});

describe("a refused redirect is disposed too", () => {
  it("cancels the redirect body instead of reading it", async () => {
    let reads = 0;
    let cancels = 0;

    stubFetch(() =>
      fakeResponse(302, {
        onRead: () => {
          reads += 1;
        },
        onCancel: () => {
          cancels += 1;
        },
      }),
    );

    const error = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect((error as SyndrooApiError).code).toBe("REDIRECT_NOT_FOLLOWED");
    await waitFor(() => cancels > 0);
    expect(reads).toBe(0);
    expect(cancels).toBeGreaterThan(0);
  });
});

describe("response bodies are bounded and copied", () => {
  it("rejects an oversized body, names the limit, and cancels the stream", async () => {
    let cancelled = 0;
    const chunk = new Uint8Array(1_024).fill(120);

    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk.slice());
            },
            cancel() {
              cancelled += 1;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const error = expectSdkError(
      await captured(client({ maxResponseBytes: 2_048 }).posts.list()),
    );

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(error.message).toContain("2048");
    expect(error.requestMayHaveBeenApplied).toBe(false);
    await waitFor(() => cancelled > 0);
    expect(cancelled).toBeGreaterThan(0);
  });

  it("copies each chunk before the next read can reuse its buffer", async () => {
    const reused = new Uint8Array(8);
    const encoder = new TextEncoder();
    const parts = ['{"items"', ":[]}    "];
    let index = 0;

    // A reader that hands back the same buffer every time, the way some fetch
    // implementations reuse one. `Response` cannot express that, so this is a
    // deliberate stand-in for the response object itself.
    const reader = {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
        const part = parts[index];
        index += 1;

        if (part === undefined) {
          return Promise.resolve({ done: true, value: undefined });
        }

        reused.set(encoder.encode(part));
        return Promise.resolve({ done: false, value: reused });
      },
      releaseLock(): void {
        // Nothing to release.
      },
      cancel(): Promise<void> {
        return Promise.resolve();
      },
    };

    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        status: 200,
        ok: true,
        type: "basic",
        headers: new Headers({ "content-type": "application/json" }),
        body: { getReader: () => reader },
      } as unknown as Response),
    );

    // Without the copy both chunks would alias the same buffer and the
    // concatenation would no longer be JSON.
    expect(await client().posts.list()).toEqual([]);
  });
});

describe("no untrusted value survives in an SDK error", () => {
  it("drops a raw fetch failure, its code, and its cause", async () => {
    const raw = Object.assign(new Error(`boom ${SENTINEL}`), {
      code: SENTINEL,
      cause: { token: SENTINEL },
    });
    vi.stubGlobal("fetch", () => Promise.reject(raw));

    const error = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooNetworkError);
    expect((error as SyndrooNetworkError).networkCode).toBeUndefined();
    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("does not forward a typed SDK error thrown by an injected fetch", async () => {
    const hostile = new SyndrooError(`hostile ${SENTINEL}`, {
      code: "UNKNOWN",
      cause: { token: SENTINEL },
    });
    vi.stubGlobal("fetch", () => Promise.reject(hostile));

    const error = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooNetworkError);
    expect(error).not.toBe(hostile);
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("does not forward a mutated SDK error from an earlier call", async () => {
    stubFetch(() =>
      json(500, { error: { code: "INTERNAL_ERROR", message: "first" } }),
    );

    const first = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(first).toBeInstanceOf(SyndrooApiError);

    // A real SDK error, mutated after the call that built it, thrown back in.
    (first as { message: string }).message = `mutated ${SENTINEL}`;
    Object.assign(first, { cause: { token: SENTINEL }, preview: SENTINEL });
    vi.stubGlobal("fetch", () => Promise.reject(first));

    const second = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(SyndrooNetworkError);
    expect(serialized(second)).not.toContain(SENTINEL);
  });

  it("does not forward a mutated SDK error thrown by a body read", async () => {
    stubFetch(() =>
      json(500, { error: { code: "INTERNAL_ERROR", message: "first" } }),
    );

    const first = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    (first as { message: string }).message = `mutated ${SENTINEL}`;
    Object.assign(first, { cause: { token: SENTINEL }, preview: SENTINEL });
    stubFetch(() => fakeResponse(200, { readError: first }));

    const second = expectSdkError(await captured(client().posts.get("post_1")));

    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(SyndrooNetworkError);
    expect(serialized(second)).not.toContain(SENTINEL);
  });

  it("does not keep an abort reason", async () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = client().posts.create(
      { content: "Hello", platforms: ["bluesky"] },
      { signal: controller.signal },
    );

    await waitFor(() => calls.length === 1);
    controller.abort(new Error(`abort ${SENTINEL}`));

    const error = expectSdkError(await captured(pending));

    expect(error).toBeInstanceOf(SyndrooAbortError);
    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect((error as SyndrooAbortError).cause).toBeUndefined();
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("does not echo a server message body", async () => {
    stubFetch(() =>
      json(500, {
        error: { code: "INTERNAL_ERROR", message: `storage said ${SENTINEL}` },
      }),
    );

    const error = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect((error as SyndrooApiError).code).toBe("INTERNAL_ERROR");
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("does not echo an invalid JSON body or fill the preview", async () => {
    stubFetch(
      () =>
        new Response(`<html>${SENTINEL}</html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = expectSdkError(await captured(client().posts.list()));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect((error as SyndrooResponseError).preview).toBeUndefined();
    expect(error.message).toContain("not JSON");
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("survives a hostile failure whose code and cause getters throw", async () => {
    const hostile = {
      get code(): string {
        throw new Error(`code ${SENTINEL}`);
      },
      get cause(): unknown {
        throw new Error(`cause ${SENTINEL}`);
      },
    };
    vi.stubGlobal("fetch", () => Promise.reject(hostile));

    const error = expectSdkError(
      await captured(
        client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooNetworkError);
    expect((error as SyndrooNetworkError).networkCode).toBeUndefined();
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("does not echo an override key from the request", async () => {
    stubFetch(() => json(202, { id: "post_1", status: "queued" }));
    const overrides = {
      [`bluesky${SENTINEL}`]: { content: 42 },
    } as unknown as Record<string, { content?: string }>;

    const error = expectSdkError(
      await captured(
        client().posts.create({
          content: "Hello",
          platforms: ["bluesky"],
          overrides,
        }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(serialized(error)).not.toContain(SENTINEL);
    expect(calls).toEqual([]);
  });

  it("does not echo an override key from the response", async () => {
    stubFetch(() =>
      json(200, {
        id: "post_1",
        content: "Hello",
        platforms: ["bluesky"],
        status: "published",
        createdAt: "2030-01-02T03:04:05.000Z",
        publications: [],
        overrides: { [`bluesky${SENTINEL}`]: 5 },
      }),
    );

    const error = expectSdkError(await captured(client().posts.get("post_1")));

    expect(error).toBeInstanceOf(SyndrooResponseError);
    expect(serialized(error)).not.toContain(SENTINEL);
  });

  it("does not echo an unrecognized post status in the wait message", async () => {
    const status = `queued${SENTINEL}`;
    stubFetch(() => json(200, { ...detail(status) }));

    const error = expectSdkError(
      await captured(
        client().posts.wait("post_1", { timeoutMs: 120, pollIntervalMs: 20 }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooWaitTimeoutError);
    expect(error.message).toContain("not one this SDK recognizes");

    // The diagnostic text is fixed; only the documented snapshot keeps the raw
    // status, and that property stays for compatibility.
    const failure = error as {
      message: string;
      stack?: string;
      cause?: unknown;
      preview?: unknown;
    };

    expect(
      [failure.message, failure.stack ?? "", String(failure.cause), String(failure.preview)].join(
        "\n",
      ),
    ).not.toContain(SENTINEL);

    // The documented resource snapshot is still carried unchanged.
    const wait = error as SyndrooWaitTimeoutError;

    expect(wait.lastStatus).toBe(status);
    expect(wait.lastPost?.status).toBe(status);
  });
});

describe("codes come from closed allowlists", () => {
  it("reports an allowlisted runtime network code", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(Object.assign(new Error("down"), { code: "ECONNREFUSED" })),
    );

    const error = expectSdkError(await captured(client().posts.get("post_1")));

    expect((error as SyndrooNetworkError).networkCode).toBe("ECONNREFUSED");
    expect(error.message).toContain("(ECONNREFUSED)");
  });

  const serverCodes: ReadonlyArray<{ code: string; status: number }> = [
    { code: "AUTH_CONFLICT", status: 409 },
    { code: "AUTH_IN_PROGRESS", status: 409 },
    { code: "INSTANCE_NOT_READY", status: 503 },
    { code: "STORE_UNAVAILABLE", status: 503 },
    { code: "POST_NOT_FOUND", status: 404 },
    { code: "UNAUTHORIZED", status: 401 },
    { code: "PLATFORM_NOT_CONFIGURED", status: 422 },
    { code: "PROVIDER_ERROR", status: 502 },
  ];

  for (const testCase of serverCodes) {
    it(`keeps the documented ${testCase.code}`, async () => {
      stubFetch(() =>
        json(testCase.status, {
          error: { code: testCase.code, message: SENTINEL },
        }),
      );

      const error = expectSdkError(await captured(client().posts.get("post_1")));

      expect((error as SyndrooApiError).code).toBe(testCase.code);
      expect(serialized(error)).not.toContain(SENTINEL);
    });
  }

  it("replaces an unknown or lower-case code with HTTP_<status>", async () => {
    for (const code of ["TOTALLY_MADE_UP", "invalid_request", "Error"]) {
      stubFetch(() => json(400, { error: { code, message: SENTINEL } }));

      const error = expectSdkError(await captured(client().posts.get("post_1")));

      expect((error as SyndrooApiError).code).toBe("HTTP_400");
    }
  });
});

describe("DELETE and pre-send guards", () => {
  it("supports DELETE and never retries it", async () => {
    stubFetch(() =>
      json(503, { error: { code: "STORE_UNAVAILABLE", message: "down" } }),
    );

    const error = expectSdkError(
      await captured(
        sendRequest(CONFIG, {
          method: "DELETE",
          operation: "auth.remove",
          path: "/v1/auth/x",
          timeoutMs: 500,
        }),
      ),
    );

    expect((error as SyndrooApiError).status).toBe(503);
    expect(error.requestMayHaveBeenApplied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("rejects a header-breaking api key before any request", () => {
    for (const apiKey of [
      "key with spaces",
      "key\nInjected: header",
      `key\u0000${SENTINEL}`,
    ]) {
      let error: unknown;

      try {
        client({ apiKey });
      } catch (failure) {
        error = failure;
      }

      expect(error).toBeInstanceOf(SyndrooConfigError);
      expect(error).toBeDefined();
      expect(serialized(error)).not.toContain(SENTINEL);
    }

    expect(calls).toEqual([]);
  });

  it("does not echo an unusable base URL", () => {
    for (const baseUrl of [
      `not a url ${SENTINEL}`,
      `ftp://${SENTINEL}.example.com`,
      `https://user:${SENTINEL}@syndroo.example.com`,
      `https://syndroo.example.com/?token=${SENTINEL}`,
    ]) {
      let error: unknown;

      try {
        client({ baseUrl });
      } catch (failure) {
        error = failure;
      }

      expect(error).toBeInstanceOf(SyndrooConfigError);
      expect(serialized(error)).not.toContain(SENTINEL);
    }

    expect(calls).toEqual([]);
  });

  it("rejects a body that cannot be serialized before any request", async () => {
    stubFetch(() => json(202, { id: "post_1", status: "queued" }));
    const overrides = {
      bluesky: {
        content: "Hello",
        toJSON(): unknown {
          throw new Error(`toJSON ${SENTINEL}`);
        },
      },
    } as unknown as Record<string, { content?: string }>;

    const error = expectSdkError(
      await captured(
        client().posts.create({
          content: "Hello",
          platforms: ["bluesky"],
          overrides,
        }),
      ),
    );

    expect(error).toBeInstanceOf(SyndrooValidationError);
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(serialized(error)).not.toContain(SENTINEL);
    expect(calls).toEqual([]);
  });
});

describe("the deadline keeps a standalone process alive", () => {
  const SUPPORT_DIR = new URL("./support/", import.meta.url);
  const CHILD_SCRIPT = fileURLToPath(new URL("transport-child.ts", SUPPORT_DIR));
  /** The runtime running the suite, or an explicit override. */
  const CHILD_NODE = process.env["SYNDROO_SDK_TEST_NODE"] ?? process.execPath;
  const CHILD_TIMEOUT_MS = 8_000;
  const MARKER_PREFIX = "SYNDROO_TRANSPORT_CHILD ";

  interface ChildRun {
    readonly marker: Record<string, unknown>;
    readonly elapsedMs: number;
  }

  function runChild(mode: string): Promise<ChildRun> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(CHILD_NODE, [CHILD_SCRIPT, mode], {
        cwd: fileURLToPath(SUPPORT_DIR),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CHILD_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", code => {
        clearTimeout(timer);

        if (timedOut) {
          reject(
            new Error(
              `The transport child (${mode}) was still running after ` +
                `${CHILD_TIMEOUT_MS}ms and had to be killed. stdout: ${stdout} ` +
                `stderr: ${stderr}`,
            ),
          );
          return;
        }

        if (code !== 0) {
          reject(
            new Error(
              `The transport child (${mode}) exited with code ${code}. ` +
                `stdout: ${stdout} stderr: ${stderr}`,
            ),
          );
          return;
        }

        const line = stdout
          .split("\n")
          .reverse()
          .find(entry => entry.startsWith(MARKER_PREFIX));

        if (line === undefined) {
          reject(
            new Error(
              `The transport child (${mode}) exited without its marker. ` +
                `stdout: ${stdout}`,
            ),
          );
          return;
        }

        resolve({
          marker: JSON.parse(line.slice(MARKER_PREFIX.length)) as Record<string, unknown>,
          elapsedMs: Date.now() - startedAt,
        });
      });
    });
  }

  it(
    "settles a hanging fetch at the deadline and exits on its own",
    async () => {
      const run = await runChild("hanging-fetch");

      expect(run.marker["event"]).toBe("rejected");
      expect(run.marker["code"]).toBe("TIMEOUT");
      expect(run.marker["operation"]).toBe("posts.get");
      expect(run.marker["requestMayHaveBeenApplied"]).toBe(false);
      expect(run.marker["requests"]).toEqual(["GET"]);
      expect(run.elapsedMs).toBeLessThan(5_000);
    },
    20_000,
  );

  it(
    "settles a hanging body, cancels it, and exits on its own",
    async () => {
      const run = await runChild("hanging-body");

      expect(run.marker["event"]).toBe("rejected");
      expect(run.marker["code"]).toBe("TIMEOUT");
      expect(run.marker["requests"]).toEqual(["GET"]);
      expect(run.marker["cancellations"]).toBeGreaterThan(0);
      expect(run.elapsedMs).toBeLessThan(5_000);
    },
    20_000,
  );
});
