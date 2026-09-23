/**
 * Explicit local Worker test bindings shared by the main Worker project and the
 * isolated egress canary.
 *
 * Nothing here reads the production Wrangler configuration, a credential file
 * or a remote resource: the D1 database, the publication queue and every
 * binding below are local synthetics created per workerd instance. Outbound
 * traffic is fail-closed, so a test that forgets to install a provider mock
 * fails instead of reaching the network.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readD1Migrations } from "@cloudflare/vitest-plugin";

const here = dirname(fileURLToPath(import.meta.url));

/** Worker package root, two levels above `test/support`. */
export const workerPackageRoot = resolve(here, "../..");

/** Worker entry point used by the main project and the egress canary. */
export const workerEntry = resolve(workerPackageRoot, "src/index.ts");

/**
 * Fixed rejection text for every unrecognised outbound request.
 *
 * It deliberately interpolates nothing: the attempted URL, request headers and
 * request body must never reach the failure message.
 */
export const OUTBOUND_REJECTED_MESSAGE =
  "outbound network access is disabled in Worker tests";

/**
 * Fail-closed outbound service.
 *
 * Every request, including the Cloudflare metadata endpoints, receives the same
 * fixed 500 body: no request line, header or payload is echoed back, and a
 * missing provider mock becomes a deterministic local failure instead of a real
 * request.
 */
export async function rejectAllOutbound(): Promise<Response> {
  return new Response(OUTBOUND_REJECTED_MESSAGE, {
    status: 500,
    headers: { "content-type": "text/plain" },
  });
}

/** Queue name used by the legacy fixture tests (`createMessageBatch`). */
export const WORKER_TEST_QUEUE = "syndroo-publications";

/**
 * Builds the miniflare options for the Worker's own test project.
 *
 * The shape mirrors the previous Wrangler-derived bindings (D1 database,
 * publication queue producer/consumer, synthetic secrets) while removing the
 * Wrangler configuration and any remote proxy session entirely.
 *
 * The consumer declaration is required, not decorative: `orchestration.spec.ts`
 * enqueues through the real binding and then polls (300 attempts, 10ms apart)
 * for the publication to reach `published`/`failed`, which only happens when
 * the broker delivers the batch back into the worker's queue handler. Removing
 * it fails four orchestration tests. The same delivery work is the leading
 * explanation for the non-failing `EnvironmentTeardownError` teardown artifact
 * recorded in `docs/v0.5.0/evidence/worker-teardown.md`.
 */
export async function createWorkerTestProjectOptions() {
  return {
    main: workerEntry,
    remoteBindings: false,
    miniflare: {
      compatibilityDate: "2026-09-02",
      compatibilityFlags: ["nodejs_compat"],
      // Local, disposable, account-free identifiers.
      d1Databases: { DB: "syndroo-worker-test-v050" },
      queueProducers: { PUBLICATION_QUEUE: WORKER_TEST_QUEUE },
      queueConsumers: {
        [WORKER_TEST_QUEUE]: {
          maxBatchSize: 1,
          maxBatchTimeout: 5,
          maxRetries: 2,
          retryDelay: 60,
        },
      },
      outboundService: rejectAllOutbound,
      // Disables Miniflare's Cloudflare metadata fetch.
      cf: false,
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(
          resolve(workerPackageRoot, "migrations"),
        ),
        SYNDROO_API_KEY: "test-api-key",
        SYNDROO_MAINTENANCE: "false",
        BLUESKY_IDENTIFIER: "test.invalid",
        BLUESKY_PASSWORD: "not-a-real-password",
        BLUESKY_HOST: "bsky.social",
        THREADS_ACCESS_TOKEN: "not-a-real-token",
      },
    },
  };
}
