import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FrozenDelivery, LocalProviderId, TargetBinding } from "@syndroo/core";

import { canonicalJson } from "../../src/local/document.js";
import { signLocalPlan } from "../../src/local/plan.js";
import type {
  ConnectionRecord,
  LocalPlan,
  LocalStore,
  PlanAction,
  PlanItem,
  PlanKind,
} from "../../src/local/ports/local-store.js";
import {
  createLocalFileStore,
  recoverLocalState,
  withLocalWriteLock,
  type FaultInjector,
} from "../../src/local/state/store.js";

/**
 * Real-process writer fixture.
 *
 * The parent tests compile this module with the repository TypeScript into a
 * temporary directory and spawn it as a genuine node child, so lock contention,
 * kill points, and crash recovery are exercised by real OS processes instead of
 * two promises inside one event loop.
 *
 * The module is also imported directly by the tests for its plan, connection,
 * and spawn helpers, so it must not import the test runner.
 */

export const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const REPO_ROOT = path.resolve(CLI_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// Test-side record helpers
// ---------------------------------------------------------------------------

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SeedConnectionOptions {
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
  readonly removed?: boolean;
  readonly expectedRevision?: number | null;
}

export function connectionRecord(
  options: SeedConnectionOptions,
): ConnectionRecord {
  return {
    schemaVersion: 1,
    target: {
      provider: options.provider,
      targetId: options.targetId,
      connectionId: options.connectionId,
      bindingRevision: options.bindingRevision,
    },
    source: { kind: "env", provider: options.provider },
    fingerprint: sha256Hex(`credential:v1:${options.provider}`),
    removed: options.removed ?? false,
  };
}

export async function seedConnection(
  store: LocalStore,
  options: SeedConnectionOptions,
): Promise<void> {
  await store.putConnection(
    connectionRecord(options),
    options.expectedRevision ?? null,
  );
}

export interface TestPlanOptions {
  readonly store: LocalStore;
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly provider: LocalProviderId;
  readonly targetId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
  readonly action?: PlanAction;
  readonly kind?: PlanKind;
  readonly parentOperationId?: string | null;
  readonly previousBinding?: TargetBinding | null;
  readonly createdAt?: Date;
  readonly ttlMs?: number;
  readonly payloadVersion?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly target?: TargetBinding;
  readonly delivery?: FrozenDelivery;
  readonly planId?: string;
}

/** One frozen delivery, built exactly as the frozen local contract describes. */
export function frozenDelivery(options: {
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly target: TargetBinding;
  readonly payloadVersion?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}): FrozenDelivery {
  const payloadVersion = options.payloadVersion ?? 1;
  const payload = options.payload ?? {
    text: options.content,
    createdAt: "2026-09-24T00:00:00.000Z",
  };

  return {
    deliveryId: sha256Hex(
      canonicalJson([
        options.namespace,
        options.key,
        options.target.provider,
        options.target.targetId,
      ]),
    ),
    key: options.key,
    namespace: options.namespace,
    target: options.target,
    content: options.content,
    payloadVersion,
    payloadHash: sha256Hex(canonicalJson({ payloadVersion, payload })),
    payload,
  };
}

/** Builds and signs one plan with the production signer. */
export async function buildTestPlan(
  options: TestPlanOptions,
): Promise<LocalPlan> {
  const installation = await options.store.getInstallation();
  const createdAt = (options.createdAt ?? new Date()).toISOString();
  const expiresAt = new Date(
    Date.parse(createdAt) + (options.ttlMs ?? 24 * 60 * 60 * 1000),
  ).toISOString();
  const target: TargetBinding = options.target ?? {
    provider: options.provider,
    targetId: options.targetId,
    connectionId: options.connectionId,
    bindingRevision: options.bindingRevision,
  };
  const delivery =
    options.delivery ??
    frozenDelivery({
      namespace: options.namespace,
      key: options.key,
      content: options.content,
      target,
      ...(options.payloadVersion === undefined
        ? {}
        : { payloadVersion: options.payloadVersion }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  const item: PlanItem = {
    delivery,
    action: options.action ?? "publish",
    previousBinding: options.previousBinding ?? null,
  };
  const body = {
    schemaVersion: 1 as const,
    installationId: installation.installationId,
    planId: options.planId ?? `plan_${randomBytes(16).toString("hex")}`,
    kind: options.kind ?? "publish",
    namespace: options.namespace,
    createdAt,
    expiresAt,
    items: [item],
    parentOperationId: options.parentOperationId ?? null,
  };
  const { digest, mac } = await signLocalPlan(body, options.store);

  return { ...body, digest, mac };
}

/**
 * Writes one record with a valid installation MAC.
 *
 * Used to forge states the store must refuse, such as a delivery that is
 * `in_flight` while its operation manifest is still `preparing`.
 */
export function forgeRecord(
  stateHome: string,
  collection: string,
  id: string,
  data: unknown,
): void {
  const key = readFileSync(path.join(stateHome, "integrity.key"));
  const mac = createHmac("sha256", key)
    .update(`record:v1:${collection}:${id}:${canonicalJson(data)}`, "utf8")
    .digest("hex");
  const file = path.join(stateHome, collection, `${id}.json`);

  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, data, mac }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// Child compilation
// ---------------------------------------------------------------------------

/**
 * Compiles this fixture and the state modules it imports into `outDir`.
 *
 * The repository TypeScript compiler is invoked as a real child. Type-only
 * imports are erased, so an unresolved workspace type does not block the emit
 * (`noEmitOnError` stays off), and a `node_modules` symlink keeps runtime
 * dependencies resolvable from the temporary directory.
 */
export function compileWriter(outDir: string): string {
  const entry = path.join(CLI_ROOT, "test", "fixtures", "local-writer.ts");
  const configPath = path.join(path.dirname(outDir), "tsconfig.writer.json");

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: CLI_ROOT,
          outDir,
          strict: false,
          skipLibCheck: true,
          types: ["node"],
          lib: ["ES2022"],
          verbatimModuleSyntax: true,
          declaration: false,
          sourceMap: false,
          noEmitOnError: false,
        },
        files: [entry],
      },
      null,
      2,
    )}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", configPath],
    { encoding: "utf8" },
  );

  const emitted = path.join(outDir, "test", "fixtures", "local-writer.js");

  if (!existsSync(emitted)) {
    throw new Error(
      `the local writer fixture did not compile: ${result.stdout}${result.stderr}`,
    );
  }

  const modules = path.join(outDir, "node_modules");

  if (!existsSync(modules)) {
    symlinkSync(path.join(REPO_ROOT, "node_modules"), modules, "dir");
  }

  return emitted;
}

// ---------------------------------------------------------------------------
// Parent-side spawn helper
// ---------------------------------------------------------------------------

export interface WriterRun {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: unknown;
}

export interface WriterOptions {
  readonly entry: string;
  readonly mode: string;
  readonly stateHome: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Runs one real node child against the compiled fixture. */
export function runWriter(options: WriterOptions): Promise<WriterRun> {
  const reportPath = path.join(
    path.dirname(options.stateHome),
    `report-${randomBytes(6).toString("hex")}.json`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.entry, options.mode], {
      env: {
        ...process.env,
        SYNDROO_T03_STATE: options.stateHome,
        SYNDROO_T03_REPORT: reportPath,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);

    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);

      let report: unknown = null;

      if (existsSync(reportPath)) {
        try {
          report = JSON.parse(readFileSync(reportPath, "utf8"));
        } catch {
          report = null;
        }
      }

      resolve({ code, signal, stdout, stderr, report });
    });
  });
}

// ---------------------------------------------------------------------------
// Child entry point
// ---------------------------------------------------------------------------

function env(name: string): string | undefined {
  return process.env[name];
}

function requiredEnv(name: string): string {
  const value = env(name);

  if (value === undefined) {
    throw new Error(`missing fixture environment variable ${name}`);
  }

  return value;
}

function writeReport(value: unknown): void {
  writeFileSync(requiredEnv("SYNDROO_T03_REPORT"), `${JSON.stringify(value)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function provider(): LocalProviderId {
  return (env("SYNDROO_T03_PROVIDER") ?? "bluesky") as LocalProviderId;
}

/**
 * Kills this process at the chosen atomic write.
 *
 * `SYNDROO_T03_KILL_AT` counts writes and `SYNDROO_T03_KILL_POINT` names the
 * checkpoint inside that write. A kill at `after-file-sync` leaves the writer's
 * own temporary file behind, exactly like a real crash.
 */
function killInjector(): FaultInjector | undefined {
  const raw = env("SYNDROO_T03_KILL_AT");

  if (raw === undefined) {
    return undefined;
  }

  const target = Number(raw);
  const point = env("SYNDROO_T03_KILL_POINT") ?? "after-file-sync";
  let writes = 0;

  return faultPoint => {
    if (faultPoint === "before-temp-write") {
      writes += 1;
    }

    if (writes === target && faultPoint === point) {
      process.kill(process.pid, "SIGKILL");
    }
  };
}

/** Initializes the state, binds one account, and stores one signed plan. */
async function seedStore(store: LocalStore): Promise<LocalPlan> {
  await store.initialize();
  await seedConnection(store, {
    provider: provider(),
    targetId: env("SYNDROO_T03_TARGET") ?? "did:plc:fixture",
    connectionId: `conn_${"a".repeat(32)}`,
    bindingRevision: 1,
  });

  const plan = await buildTestPlan({
    store,
    namespace: env("SYNDROO_T03_NAMESPACE") ?? "default",
    key: env("SYNDROO_T03_KEY") ?? "fixture-key-1",
    content: env("SYNDROO_T03_CONTENT") ?? "hello from the fixture",
    provider: provider(),
    targetId: env("SYNDROO_T03_TARGET") ?? "did:plc:fixture",
    connectionId: `conn_${"a".repeat(32)}`,
    bindingRevision: 1,
  });

  await store.putPlan(plan);

  return plan;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  const home = requiredEnv("SYNDROO_T03_STATE");

  if (mode === "try-lock" || mode === "compete" || mode === "compete-retry") {
    const log = env("SYNDROO_T03_LOG");
    const attempts = mode === "compete-retry" ? Number(env("SYNDROO_T03_ATTEMPTS") ?? "60") : 1;
    const retryMs = Number(env("SYNDROO_T03_RETRY_MS") ?? "25");
    let acquired = false;

    for (let attempt = 0; attempt < attempts && !acquired; attempt++) {
      try {
        await withLocalWriteLock(home, async () => {
          acquired = true;
          writeReport({ ok: true, pid: process.pid });

          if (log !== undefined) {
            writeFileSync(log, `enter:${process.pid}\n`, { flag: "a" });
          }

          await sleep(Number(env("SYNDROO_T03_HOLD_MS") ?? "50"));

          if (log !== undefined) {
            writeFileSync(log, `exit:${process.pid}\n`, { flag: "a" });
          }

          return null;
        });
      } catch (error) {
        if (attempt === attempts - 1) {
          writeReport({
            ok: false,
            pid: process.pid,
            code: (error as { code?: string }).code ?? "UNKNOWN",
          });

          return;
        }

        await sleep(retryMs);
      }
    }

    return;
  }

  if (mode === "hold-forever") {
    await withLocalWriteLock(home, async () => {
      writeReport({ ok: true, pid: process.pid });
      // A pending timer keeps the event loop alive so the parent's signal is
      // what ends this process.
      await sleep(600_000);
    });

    return;
  }

  if (mode === "intent-then-die") {
    const store = createLocalFileStore(home);

    await withLocalWriteLock(home, async () => {
      const plan = await seedStore(store);
      const operation = await store.reserveOperation(plan);
      const deliveryId = operation.deliveryIds[0] as string;
      const attempt = await store.beginAttempt(
        operation.operationId,
        deliveryId,
        plan.items[0]?.delivery.target as TargetBinding,
      );

      writeReport({
        operationId: operation.operationId,
        deliveryId,
        attempt,
      });
      process.kill(process.pid, "SIGKILL");
    });

    return;
  }

  if (mode === "recover") {
    try {
      const report = await recoverLocalState(home, {
        confirmNoWriters: true,
        yes: true,
      });

      writeReport({ ok: true, report });
    } catch (error) {
      writeReport({
        ok: false,
        code: (error as { code?: string }).code ?? "UNKNOWN",
      });
    }

    return;
  }

  if (mode === "seed-and-crash" || mode === "seed-only") {
    const injector = killInjector();
    const store = createLocalFileStore(
      home,
      injector === undefined ? {} : { fault: injector },
    );

    await withLocalWriteLock(home, async () => {
      const plan = await seedStore(store);

      if (mode === "seed-only") {
        writeReport({ planId: plan.planId });

        return;
      }

      const operation = await store.reserveOperation(plan);

      writeReport({
        operationId: operation.operationId,
        admissionState: operation.admissionState,
      });
    });

    return;
  }

  throw new Error(`unknown fixture mode ${mode}`);
}

function isEntryPoint(): boolean {
  const script = process.argv[1];

  return (
    script !== undefined && path.resolve(script) === fileURLToPath(import.meta.url)
  );
}

if (isEntryPoint()) {
  main().catch(error => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
