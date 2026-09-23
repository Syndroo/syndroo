/**
 * Standalone child used by `transport-boundary.test.ts`.
 *
 * The deadline timer is the only thing that can settle these calls: `fetch` is
 * stubbed with a promise that never settles and ignores the AbortSignal, and
 * the `hanging-body` mode answers with a response whose body never produces a
 * byte. If the deadline stopped holding the event loop open, Node would exit 13
 * on the unsettled top-level await before the marker was ever written.
 *
 * Modes: `hanging-fetch` and `hanging-body`.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import type * as sdkTypes from "../../src/index.js";

/** Resolve the SDK's NodeNext `./x.js` specifiers to the `./x.ts` sources. */
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

const mode = process.argv[2] ?? "hanging-fetch";
const requests: string[] = [];
let cancellations = 0;

globalThis.fetch = (async (
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  requests.push(init?.method ?? "GET");

  if (mode === "hanging-body") {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue and never close: the read is bounded only by the
        // deadline.
      },
      cancel() {
        cancellations += 1;
      },
    });

    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Never settles, and ignores the AbortSignal it was handed.
  return new Promise<Response>(() => undefined);
}) as typeof globalThis.fetch;

const client = new sdk.SyndrooClient({
  baseUrl: "http://127.0.0.1:9",
  apiKey: "child-test-key-not-a-real-secret",
  timeoutMs: 150,
});

const startedAt = Date.now();
let outcome: Record<string, unknown>;

try {
  await client.posts.get("post_1");
  outcome = { event: "resolved" };
} catch (error) {
  const failure = error as {
    name?: string;
    code?: string;
    operation?: string;
    requestMayHaveBeenApplied?: boolean;
    message?: string;
  };

  outcome = {
    event: "rejected",
    name: failure.name,
    code: failure.code,
    operation: failure.operation,
    requestMayHaveBeenApplied: failure.requestMayHaveBeenApplied,
    message: failure.message,
  };
}

// The cancelled read is abandoned work: give its cancel callback a bounded
// moment to run before the marker records the count.
const cancelDeadline = Date.now() + 500;

while (cancellations === 0 && Date.now() < cancelDeadline) {
  await new Promise(resolve => setTimeout(resolve, 10));
}

process.stdout.write(
  `SYNDROO_TRANSPORT_CHILD ${JSON.stringify({
    mode,
    requests,
    cancellations,
    elapsedMs: Date.now() - startedAt,
    ...outcome,
  })}\n`,
);
