import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  FetcherQueueResult,
  FetcherScheduledResult,
} from "@cloudflare/workers-types/experimental";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";

import { MockSnsServer } from "./mock-sns-server.js";
import { createOutboundPolicy, type OutboundPolicy } from "./outbound-policy.js";
import { MOCK_CREDENTIALS, describeError, redact } from "./redact.js";

const E2E_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY_ROOT = resolve(E2E_DIRECTORY, "..");
/** The real bundled production Worker, not the TypeScript sources. */
export const WORKER_BUNDLE_PATH = join(
  REPOSITORY_ROOT,
  "packages/cloudflare-worker/dist/index.js",
);

const MIGRATIONS_DIRECTORY = join(
  REPOSITORY_ROOT,
  "packages/cloudflare-worker/migrations",
);
const PACKAGES_DIRECTORY = join(REPOSITORY_ROOT, "packages");
const WRANGLER_CONFIG_PATH = join(REPOSITORY_ROOT, "wrangler.jsonc");

const WORKER_NAME = "syndroo-e2e";
const QUEUE_BINDING = "PUBLICATION_QUEUE";
const QUEUE_NAME = "syndroo-publications";
const CRON = "*/15 * * * *";
const COMPATIBILITY_DATE = "2026-09-02";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];
const WORKER_ORIGIN = "http://syndroo.e2e";
const CLOSE_TIMEOUT_MS = 15_000;
const LOG_LIMIT = 200;

/**
 * Strings that must exist in the bundled Worker. They prove the bundle was
 * built from the production publishers rather than an unrelated artifact.
 */
const REQUIRED_BUNDLE_MARKERS = [
  "https://graph.threads.net",
  "app.bsky.feed.post",
  "PLATFORM_NOT_CONFIGURED",
] as const;

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
}

interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

/** Low-level handles the Mock SNS tests drive. */
export interface Harness {
  readonly mockSns: MockSnsServer;
  readonly policy: OutboundPolicy;
  readonly apiKey: string;
  /** Dispatch an HTTP request to the Worker entrypoint. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Deliver one publication job through the Worker's queue handler. */
  deliverQueueMessage(body: { publicationId: string }): Promise<FetcherQueueResult>;
  /** Run the Worker's `scheduled` handler with a controlled event time. */
  runScheduled(
    scheduledTime: number | Date,
    cron?: string,
  ): Promise<FetcherScheduledResult>;
  /** Worker `console` output captured during the run. */
  logs(): readonly string[];
  /** Redacted, human-readable failure context. */
  diagnostics(): string;
  /** Stop Miniflare and the loopback Mock SNS server. Safe to call once. */
  dispose(): Promise<void>;
}

/**
 * Refuses to run against a missing, stale, or unrelated Worker bundle. The
 * gate only means something when it exercises the real production artifact.
 */
export async function assertBundleReady(): Promise<void> {
  const config = await readFile(WRANGLER_CONFIG_PATH, "utf8");
  const configExpectations: readonly (readonly [string, string])[] = [
    ["compatibility date", `"compatibility_date": "${COMPATIBILITY_DATE}"`],
    ["queue binding", `"binding": "${QUEUE_BINDING}"`],
    ["queue name", `"queue": "${QUEUE_NAME}"`],
  ];

  for (const [label, expected] of configExpectations) {
    if (!config.includes(expected)) {
      throw new Error(
        `The Mock SNS harness is out of sync with wrangler.jsonc: ${label} ` +
          `does not match ${expected}. Update e2e/src/harness.ts.`,
      );
    }
  }

  let bundle: Stats;

  try {
    bundle = await stat(WORKER_BUNDLE_PATH);
  } catch {
    throw new Error(
      `The bundled Worker is missing at ${relative(REPOSITORY_ROOT, WORKER_BUNDLE_PATH)}. ` +
        `Run "npm run build:package" first; the Mock SNS gate tests the production bundle.`,
    );
  }

  if (!bundle.isFile()) {
    throw new Error(`${relative(REPOSITORY_ROOT, WORKER_BUNDLE_PATH)} is not a file.`);
  }

  const newestSource = await newestSourceMtime(PACKAGES_DIRECTORY);

  if (newestSource > bundle.mtimeMs) {
    throw new Error(
      `The bundled Worker at ${relative(REPOSITORY_ROOT, WORKER_BUNDLE_PATH)} is older ` +
        'than packages/*/src. Run "npm run build:package" so the gate tests current code.',
    );
  }

  const contents = await readFile(WORKER_BUNDLE_PATH, "utf8");

  for (const marker of REQUIRED_BUNDLE_MARKERS) {
    if (!contents.includes(marker)) {
      throw new Error(
        `The bundled Worker at ${relative(REPOSITORY_ROOT, WORKER_BUNDLE_PATH)} is missing ` +
          `expected production marker ${JSON.stringify(marker)}. Run "npm run build:package".`,
      );
    }
  }
}

/**
 * Start one isolated Worker: fresh loopback Mock SNS server, fresh D1 database,
 * real local Queue, and the bundled production Worker wired to the outbound
 * policy. Every caller must `dispose()` the returned harness.
 */
export async function startHarness(): Promise<Harness> {
  await assertBundleReady();

  const mockSns = await MockSnsServer.start();
  const policy = createOutboundPolicy({ forwardOrigin: mockSns.origin });
  const logs: string[] = [];
  let miniflare: Miniflare | undefined;

  try {
    const instance = new Miniflare(
      convertV4MiniflareOptions({
        name: WORKER_NAME,
        modules: true,
        scriptPath: WORKER_BUNDLE_PATH,
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: [...COMPATIBILITY_FLAGS],
        bindings: {
          SYNDROO_API_KEY: MOCK_CREDENTIALS.apiKey,
          // Only Threads and Bluesky are configured; the other platforms stay
          // unconfigured exactly like a minimal self-hosted deployment.
          THREADS_ACCESS_TOKEN: MOCK_CREDENTIALS.threadsAccessToken,
          BLUESKY_IDENTIFIER: MOCK_CREDENTIALS.blueskyIdentifier,
          BLUESKY_PASSWORD: MOCK_CREDENTIALS.blueskyPassword,
          BLUESKY_HOST: "bsky.social",
          SYNDROO_MAINTENANCE: "false",
        },
        // A fresh database id per harness keeps tests isolated.
        d1Databases: { DB: `syndroo-e2e-${randomUUID()}` },
        queueProducers: {
          [QUEUE_BINDING]: { queueName: QUEUE_NAME, deliveryDelay: 0 },
        },
        queueConsumers: {
          [QUEUE_NAME]: {
            maxBatchSize: 1,
            // Dispatch immediately; the production Cron cadence is irrelevant.
            maxBatchTimeout: 0.05,
            maxRetries: 0,
            retryDelay: 0,
          },
        },
        outboundService: policy.handler,
        // Miniflare's `cf: true` (or a string path) fetches a real `cf` object
        // from a Cloudflare endpoint and caches it under node_modules/.mf.
        // `false` selects the documented placeholder object instead, so the
        // harness performs no background network request of its own.
        cf: false,
        log: new Log(LogLevel.NONE),
        handleStructuredLogs: entry => {
          logs.push(`[${entry.level}] ${entry.message}`);

          if (logs.length > LOG_LIMIT) {
            logs.splice(0, logs.length - LOG_LIMIT);
          }
        },
      }),
    );
    miniflare = instance;

    await instance.ready;
    await applyMigrations(
      (await instance.getD1Database("DB")) as unknown as D1DatabaseLike,
    );
    const worker = await instance.getWorker();
    let disposed = false;
    let deliverySequence = 0;

    return {
      mockSns,
      policy,
      apiKey: MOCK_CREDENTIALS.apiKey,
      async fetch(path, init) {
        // Node's and workerd's `RequestInit` are distinct types backed by
        // different undici copies; the values are interchangeable here.
        return await instance.dispatchFetch(
          `${WORKER_ORIGIN}${path}`,
          init as Parameters<Miniflare["dispatchFetch"]>[1],
        );
      },
      async deliverQueueMessage(body) {
        deliverySequence += 1;
        const result = await worker.queue(QUEUE_NAME, [
          {
            id: `${WORKER_NAME}-delivery-${deliverySequence}`,
            timestamp: new Date(),
            attempts: 1,
            body,
          },
        ]);

        requireOkOutcome(result.outcome, "queue", result);
        return result;
      },
      async runScheduled(scheduledTime, cron = CRON) {
        const result = await worker.scheduled({
          cron,
          scheduledTime: new Date(scheduledTime),
        });

        requireOkOutcome(result.outcome, "scheduled", result);
        return result;
      },
      logs() {
        return logs;
      },
      diagnostics() {
        return renderDiagnostics(logs, mockSns, policy);
      },
      async dispose() {
        if (disposed) {
          return;
        }

        disposed = true;
        const failures: string[] = [];
        await closeResources(miniflare, mockSns, failures);
        requireNoFailures("cleanup", failures);
      },
    };
  } catch (error) {
    // Never leak a workerd instance or a bound loopback port into later tests.
    const failures: string[] = [];
    await closeResources(miniflare, mockSns, failures);
    const cleanup = failures.length > 0 ? ` Cleanup also failed: ${failures.join("; ")}` : "";
    throw new Error(`Failed to start the Mock SNS harness: ${describeError(error)}.${cleanup}`);
  }
}

/** Apply every production migration, in filename order, to a fresh database. */
async function applyMigrations(db: D1DatabaseLike): Promise<void> {
  const { unstable_splitSqlQuery } = await import("wrangler");
  const files = (await readdir(MIGRATIONS_DIRECTORY))
    .filter(name => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No D1 migrations found in ${MIGRATIONS_DIRECTORY}`);
  }

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIRECTORY, file), "utf8");
    const statements = unstable_splitSqlQuery(sql).map(query => db.prepare(query));

    if (statements.length > 0) {
      await db.batch(statements);
    }
  }
}

/**
 * A trigger dispatch that did not resolve as "ok" means the Worker failed while
 * handling the event; surface it instead of letting the test continue.
 */
function requireOkOutcome(
  outcome: string,
  trigger: string,
  result: unknown,
): void {
  if (outcome !== "ok") {
    throw new Error(
      `Mock SNS harness: ${trigger} dispatch returned outcome ${JSON.stringify(outcome)}: ` +
        redact(JSON.stringify(result)),
    );
  }
}

async function closeResources(
  miniflare: Miniflare | undefined,
  mockSns: MockSnsServer,
  failures: string[],
): Promise<void> {
  if (miniflare) {
    await withTimeout(
      miniflare.dispose(),
      CLOSE_TIMEOUT_MS,
      "Miniflare dispose",
      failures,
    );
  }

  await withTimeout(mockSns.dispose(), CLOSE_TIMEOUT_MS, "Mock SNS dispose", failures);
}

/** Bound cleanup so a stuck process cannot hang the gate. */
async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  label: string,
  failures: string[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timedOut = await Promise.race([
      promise.then(() => false, error => {
        failures.push(`${label} failed: ${describeError(error)}`);
        return false;
      }),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);

    if (timedOut) {
      failures.push(`${label} did not finish within ${timeoutMs}ms`);
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function requireNoFailures(stage: string, failures: readonly string[]): void {
  if (failures.length > 0) {
    throw new Error(`Mock SNS harness ${stage} failed: ${failures.join("; ")}`);
  }
}

function renderDiagnostics(
  logs: readonly string[],
  mockSns: MockSnsServer,
  policy: OutboundPolicy,
): string {
  const lines = [
    `Mock SNS requests: ${mockSns.requests.length}`,
    ...mockSns.requests.map(
      record =>
        `  #${record.sequence} ${record.method} ${record.sourceOrigin}${record.url} ` +
        `-> ${record.plan}${record.body ? ` body=${redact(truncate(record.body, 240))}` : ""}`,
    ),
    `Outbound decisions: ${policy.attempts.length}`,
    ...policy.attempts.map(
      attempt =>
        `  #${attempt.sequence} ${attempt.decision} ${attempt.method} ` +
        `${attempt.origin}${attempt.path} (${attempt.reason})`,
    ),
    `Worker logs (last ${Math.min(logs.length, 25)} of ${logs.length}):`,
    ...logs.slice(-25).map(line => `  ${redact(line)}`),
  ];

  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

async function newestSourceMtime(directory: string): Promise<number> {
  let newest = 0;
  let entries: Dirent[];

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestTsMtime(join(directory, entry.name, "src")));
    }
  }

  return newest;
}

async function newestTsMtime(directory: string): Promise<number> {
  let newest = 0;
  let entries: Dirent[];

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestTsMtime(path));
    } else if (entry.name.endsWith(".ts")) {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    }
  }

  return newest;
}
