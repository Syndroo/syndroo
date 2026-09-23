/**
 * Standalone child process used by `wait-subprocess.test.ts`.
 *
 * `posts.wait` has to hold a real event loop open until it settles. This file
 * runs a whole Node process with a stubbed `globalThis.fetch`, so the wait is
 * exercised without a server, a socket, or a live API key. The parent test
 * asserts the marker line plus the exit code: a wait that stops keeping the
 * process alive leaves Node with an unsettled top-level await, which exits 13
 * before the marker is ever written.
 *
 * Modes: `resolve` (queued, queued, then published, twice), `deadline`
 * (always queued, so the wait budget expires), and `abort` (always queued, and
 * a caller `AbortController` fires mid-wait), and `max-timer` (the largest
 * deadline Node's timers accept, against an immediate response).
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import type * as sdkTypes from "../../src/index.js";

/**
 * The SDK source uses NodeNext `.js` specifiers, and this child loads the
 * TypeScript sources directly (Node strips the types). Resolve a `.js`
 * specifier to the sibling `.ts` file when that is what exists.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && context.parentURL !== undefined) {
      const source = new URL(specifier.replace(/\.js$/u, ".ts"), context.parentURL);

      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }

    return nextResolve(specifier, context);
  },
});

const sdk = (await import(
  new URL("../../src/index.ts", import.meta.url).href
)) as typeof sdkTypes;

const mode = process.argv[2] ?? "resolve";
const methods: string[] = [];
const warnings: string[] = [];

/**
 * `setTimeout` above this bound is clamped to 1ms with a
 * `TimeoutOverflowWarning`, so a real timer at the bound is the boundary the
 * SDK has to keep.
 */
const MAX_TIMER_MS = 2_147_483_647;

process.on("warning", warning => {
  warnings.push(`${warning.name}: ${warning.message}`);
});

function detail(status: string): sdkTypes.PostDetail {
  return {
    id: "post_1",
    content: "Hello from Syndroo",
    platforms: ["bluesky"],
    status,
    createdAt: "2030-01-02T03:04:05.000Z",
    publications: [],
  };
}

globalThis.fetch = (async (
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  methods.push(init?.method ?? "GET");
  const terminal =
    mode === "max-timer" || (mode === "resolve" && methods.length >= 3);
  const status = terminal ? "published" : "queued";

  return new Response(JSON.stringify(detail(status)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof globalThis.fetch;

/** The marker the parent test parses; keep the prefix in sync with it. */
function emit(payload: Record<string, unknown>): void {
  process.stdout.write(
    `SYNDROO_WAIT_CHILD ${JSON.stringify({
      mode,
      calls: methods.length,
      methods,
      warnings,
      ...payload,
    })}\n`,
  );
}

interface Rejection {
  name?: string | undefined;
  code?: string | undefined;
  requestMayHaveBeenApplied?: boolean | undefined;
}

async function rejection(start: () => Promise<unknown>): Promise<Rejection> {
  try {
    await start();
  } catch (error) {
    return error as Rejection;
  }

  throw new Error(`the wait resolved, but mode "${mode}" expects a rejection`);
}

// Loopback only, and no request ever leaves the process: fetch is stubbed.
const client = new sdk.SyndrooClient({
  baseUrl: "http://127.0.0.1:9",
  apiKey: "child-test-key-not-a-real-secret",
});

if (mode === "resolve") {
  const first = await client.posts.wait("post_1", {
    timeoutMs: 10_000,
    pollIntervalMs: 20,
  });
  const second = await client.posts.wait("post_1", {
    timeoutMs: 10_000,
    pollIntervalMs: 20,
  });

  emit({ event: "settled", statuses: [first.status, second.status] });
} else if (mode === "deadline") {
  const error = await rejection(() =>
    client.posts.wait("post_1", { timeoutMs: 400, pollIntervalMs: 20 }),
  );

  emit({
    event: "rejected",
    name: error.name,
    code: error.code,
    requestMayHaveBeenApplied: error.requestMayHaveBeenApplied,
  });
} else if (mode === "abort") {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 150);

  try {
    const error = await rejection(() =>
      client.posts.wait("post_1", {
        timeoutMs: 10_000,
        pollIntervalMs: 20,
        signal: controller.signal,
      }),
    );

    emit({
      event: "rejected",
      name: error.name,
      code: error.code,
      requestMayHaveBeenApplied: error.requestMayHaveBeenApplied,
    });
  } finally {
    clearTimeout(timer);
  }
} else if (mode === "max-timer") {
  // A real timer at the bound is created by the transport deadline and must be
  // cleared as soon as the response arrives; an uncleared one would keep this
  // process alive for the next 24 days.
  const maxClient = new sdk.SyndrooClient({
    baseUrl: "http://127.0.0.1:9",
    apiKey: "child-test-key-not-a-real-secret",
    timeoutMs: MAX_TIMER_MS,
  });
  const post = await maxClient.posts.get("post_1");
  const waited = await maxClient.posts.wait("post_1", {
    timeoutMs: MAX_TIMER_MS,
    pollIntervalMs: MAX_TIMER_MS,
    maxPollIntervalMs: MAX_TIMER_MS,
  });

  emit({ event: "settled", statuses: [post.status, waited.status] });
} else {
  throw new Error(`unknown wait child mode: ${mode}`);
}
