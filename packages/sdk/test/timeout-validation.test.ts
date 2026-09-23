/**
 * Every caller-supplied duration — client options, per-call deadlines, wait
 * budgets, and poll intervals — is bounded by the largest delay Node's timers
 * honor. Above that bound `setTimeout` does not fail: it clamps the delay to
 * 1ms and prints a `TimeoutOverflowWarning`, which would turn a long deadline
 * into an immediate one. These cases check that the SDK refuses such values
 * before any request or timer exists, and that the boundary value itself works.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyndrooClient,
  SyndrooConfigError,
  type SyndrooClientOptions,
  type PostDetail,
} from "../src/index.js";

const API_KEY = "test-instance-key-not-a-real-secret";
const BASE_URL = "https://syndroo.example.com";
/** Node's largest timer delay: one more is clamped to 1ms with a warning. */
const MAX_TIMER_MS = 2_147_483_647;

const INVALID_DURATIONS = [
  { label: "zero", value: 0 },
  { label: "a negative value", value: -1 },
  { label: "NaN", value: Number.NaN },
  { label: "Infinity", value: Number.POSITIVE_INFINITY },
  { label: "Number.MAX_SAFE_INTEGER", value: Number.MAX_SAFE_INTEGER },
  { label: "one past the Node timer bound", value: MAX_TIMER_MS + 1 },
] as const;

const TERMINAL_POST: PostDetail = {
  id: "post_1",
  content: "Hello from Syndroo",
  platforms: ["bluesky"],
  status: "published",
  createdAt: "2030-01-02T03:04:05.000Z",
  publications: [],
};

const calls: string[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(init?.method ?? "GET");

      return Promise.resolve(
        new Response(JSON.stringify(TERMINAL_POST), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

function client(options: Partial<SyndrooClientOptions> = {}): SyndrooClient {
  return new SyndrooClient({ baseUrl: BASE_URL, apiKey: API_KEY, ...options });
}

function expectConfigError(error: unknown): SyndrooConfigError {
  expect(error).toBeInstanceOf(SyndrooConfigError);

  if (!(error instanceof SyndrooConfigError)) {
    throw new Error("Expected a SyndrooConfigError.");
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

describe("client durations are bounded by Node's timer limit", () => {
  for (const invalid of INVALID_DURATIONS) {
    it(`rejects ${invalid.label} as a client duration before any request`, () => {
      expect(() => client({ timeoutMs: invalid.value })).toThrowError(
        SyndrooConfigError,
      );
      expect(() => client({ timeoutMs: invalid.value })).toThrowError(
        /timeoutMs/u,
      );
      expect(() => client({ waitTimeoutMs: invalid.value })).toThrowError(
        SyndrooConfigError,
      );
      expect(() => client({ waitTimeoutMs: invalid.value })).toThrowError(
        /waitTimeoutMs/u,
      );
    });
  }

  it("accepts the largest Node timer deadline and fractional milliseconds", () => {
    expect(() =>
      client({ timeoutMs: MAX_TIMER_MS, waitTimeoutMs: MAX_TIMER_MS }),
    ).not.toThrow();
    expect(() => client({ timeoutMs: 1.5, waitTimeoutMs: 0.5 })).not.toThrow();
  });
});

const CALL_SHAPES = [
  {
    label: "health timeoutMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.health({ timeoutMs: value }),
  },
  {
    label: "posts.create timeoutMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.posts.create(
        { content: "Hello", platforms: ["bluesky"] },
        { timeoutMs: value },
      ),
  },
  {
    label: "posts.get timeoutMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.posts.get("post_1", { timeoutMs: value }),
  },
  {
    label: "posts.list timeoutMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.posts.list({ timeoutMs: value }),
  },
  {
    label: "posts.wait timeoutMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.posts.wait("post_1", { timeoutMs: value }),
  },
  {
    label: "posts.wait pollIntervalMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.posts.wait("post_1", { pollIntervalMs: value }),
  },
  {
    label: "posts.wait maxPollIntervalMs",
    start: (syndroo: SyndrooClient, value: number) =>
      syndroo.posts.wait("post_1", { maxPollIntervalMs: value }),
  },
] as const;

describe("per-call durations are rejected before any request", () => {
  for (const shape of CALL_SHAPES) {
    for (const invalid of INVALID_DURATIONS) {
      it(`rejects ${invalid.label} in ${shape.label}`, async () => {
        stubFetch();

        const error = expectConfigError(
          await captured(shape.start(client(), invalid.value)),
        );

        expect(error.message).toMatch(/milliseconds/u);
        expect(error.requestMayHaveBeenApplied).toBe(false);
        expect(calls).toEqual([]);
      });
    }
  }
});

describe("the boundary value is usable", () => {
  it("accepts the largest deadline for a request and clears its timer", async () => {
    stubFetch();
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);

    try {
      const post = await client({ timeoutMs: MAX_TIMER_MS }).posts.get("post_1");

      expect(post.status).toBe("published");
      expect(calls).toEqual(["GET"]);
    } finally {
      process.off("warning", onWarning);
    }

    expect(warnings).not.toContain("TimeoutOverflowWarning");
  });

  it("accepts the largest deadline and poll interval for a wait", async () => {
    stubFetch();

    const post = await client().posts.wait("post_1", {
      timeoutMs: MAX_TIMER_MS,
      pollIntervalMs: MAX_TIMER_MS,
      maxPollIntervalMs: MAX_TIMER_MS,
    });

    expect(post.status).toBe("published");
    expect(calls).toEqual(["GET"]);
  });
});
