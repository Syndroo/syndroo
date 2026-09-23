/**
 * A malformed success body must not erase what the transport already learned:
 * the HTTP status, and whether a write may already have been applied. These
 * cases stub `globalThis.fetch` so each shape is checked against an immediate
 * `Response` fixture, and the recorded calls prove the SDK sent exactly one
 * request and never retried it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SyndrooClient, SyndrooResponseError } from "../src/index.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const BASE_URL = "https://syndroo.example.com";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
}

function stubFetch(status: number, body: string | null): RecordedCall[] {
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });

      return Promise.resolve(
        new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  );

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(): SyndrooClient {
  return new SyndrooClient({ baseUrl: BASE_URL, apiKey: API_KEY });
}

const MALFORMED_RECEIPTS = [
  { label: "a JSON null body", body: "null", detail: "received null" },
  {
    label: "an array body",
    body: "[]",
    detail: "received an array",
  },
  {
    label: "a string body",
    body: '"queued"',
    detail: "received a string",
  },
  { label: "a number body", body: "42", detail: "received a number" },
  { label: "a boolean body", body: "true", detail: "received a boolean" },
  { label: "an empty body", body: null, detail: "received undefined" },
  {
    label: "a body without an id",
    body: '{"status":"queued"}',
    detail: "create response id must be a string",
  },
  {
    label: "a body with a non-string status",
    body: '{"id":"post_1","status":7}',
    detail: "create response status must be a string",
  },
] as const;

describe("malformed successful responses keep the transport context", () => {
  for (const shape of MALFORMED_RECEIPTS) {
    it(`reports HTTP 202 with ${shape.label} as a write that may have landed`, async () => {
      const calls = stubFetch(202, shape.body);

      const error = expectResponseError(
        await captured(
          client().posts.create({ content: "Hello", platforms: ["bluesky"] }),
        ),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.status).toBe(202);
      expect(error.requestMayHaveBeenApplied).toBe(true);
      expect(error.message).toContain("does not match the documented contract");
      expect(error.message).toContain(shape.detail);
      expect(calls).toEqual([{ url: `${BASE_URL}/v1/posts`, method: "POST" }]);
    });
  }

  it("keeps a malformed read at its own status and never claims a write", async () => {
    const calls = stubFetch(200, "null");

    const error = expectResponseError(
      await captured(client().posts.get("post_1")),
    );

    expect(error.status).toBe(200);
    expect(error.requestMayHaveBeenApplied).toBe(false);
    expect(calls).toEqual([
      { url: `${BASE_URL}/v1/posts/post_1`, method: "GET" },
    ]);
  });
});

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
