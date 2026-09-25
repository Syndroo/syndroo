import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  LocalProvider,
  LocalProviderId,
  PreparedTarget,
  ProviderOutcome,
} from "@syndroo/core";

import { CliError } from "../../src/cli-error.js";
import { executeLocalPlan } from "../../src/local/execute.js";
import { exitCodeForResult } from "../../src/local/results.js";
import {
  createLocalFileStore,
  withLocalWriteLock,
} from "../../src/local/state/store.js";

/**
 * Real-process execution fixture.
 *
 * The parent tests compile this module with the repository TypeScript into a
 * temporary directory and spawn it as a genuine node child, so a signal, a
 * kill, and lock contention are exercised by real OS processes. The module is
 * also imported directly by the tests for its compile and spawn helpers, so it
 * must not import the test runner.
 */

export const CLI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const REPO_ROOT = path.resolve(CLI_ROOT, "..", "..");

export type ChildMode = "steady" | "hold" | "abort" | "silent";

/**
 * Compiles this fixture and the local modules it imports into `outDir`.
 *
 * Dependencies resolve from the temporary tree, so the `node_modules` symlink
 * is created before compilation: a transient temporary path must never turn
 * into a false module or type error. A compile failure is fatal — the fixture
 * never reports success for a child it could not build.
 */
export function compileExecutionChild(outDir: string): string {
  const entry = path.join(CLI_ROOT, "test", "fixtures", "local-execute-child.ts");
  const configPath = path.join(path.dirname(outDir), "tsconfig.child.json");

  mkdirSync(outDir, { recursive: true });

  const modules = path.join(outDir, "node_modules");

  if (!existsSync(modules)) {
    symlinkSync(path.join(REPO_ROOT, "node_modules"), modules, "dir");
  }

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
          strict: true,
          skipLibCheck: true,
          // The config lives outside the temporary tree, so the type roots are
          // named explicitly instead of relying on directory walking.
          typeRoots: [path.join(outDir, "node_modules", "@types")],
          types: ["node"],
          lib: ["ES2022"],
          verbatimModuleSyntax: true,
          declaration: false,
          sourceMap: false,
          noEmitOnError: true,
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
  const emitted = path.join(outDir, "test", "fixtures", "local-execute-child.js");

  if (result.status !== 0 || !existsSync(emitted)) {
    throw new Error(
      `the execution child fixture did not compile (exit ${String(result.status)}): ` +
        `${result.stdout}${result.stderr}`,
    );
  }

  return emitted;
}

export interface ChildEvidence {
  readonly mode: ChildMode;
  readonly exitCode: number;
  readonly publishCalls: number;
  readonly publishedIds: readonly string[];
  readonly status?: string;
  readonly durability?: string;
  readonly interrupted?: boolean;
  readonly results?: readonly {
    readonly provider: string;
    readonly status: string;
    readonly attempts: number;
    readonly reused: boolean;
  }[];
  /** Present when the child never reached execution. */
  readonly lockError?: string;
}

export interface SpawnedChild {
  readonly child: ChildProcess;
  /** Attached at spawn time, so an immediate exit is never missed. */
  readonly exited: Promise<number>;
  readonly stderr: () => string;
}

/**
 * Spawns one child process in the given mode; no shell is involved.
 *
 * `nowIso` is the parent fixture's clock snapshot. The child uses exactly that
 * instant, so the frozen plan's 24h TTL is evaluated against the clock the plan
 * was frozen with instead of the wall clock.
 */
export function spawnExecutionChild(
  entry: string,
  mode: ChildMode,
  stateHome: string,
  planId: string,
  controlDir: string,
  nowIso: string,
): SpawnedChild {
  const child = spawn(
    process.execPath,
    [entry, mode, stateHome, planId, controlDir, nowIso],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";

  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve(code ?? -1));
  });

  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
  });
  child.stdout?.on("data", () => {
    // The child reports through its evidence file; stdout is only noise here.
  });

  return { child, exited, stderr: () => stderr };
}

export async function waitForExit(child: SpawnedChild): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.child.kill("SIGKILL");
          reject(
            new Error(
              `the child did not exit in time: ${child.stderr()}`,
            ),
          );
        }, 20_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Ends a child that is still running, so a failed assertion leaves no worker. */
export function killChild(child: SpawnedChild): void {
  if (child.child.exitCode === null && child.child.signalCode === null) {
    child.child.kill("SIGKILL");
  }
}

/** Waits for a file the child creates, so the parent acts on real state. */
export async function waitForFile(
  file: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path.basename(file)}`);
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export function readEvidence(file: string): ChildEvidence {
  return JSON.parse(readFileSync(file, "utf8")) as ChildEvidence;
}

// ---------------------------------------------------------------------------
// Child entry
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFileInChild(file: string): Promise<void> {
  while (!existsSync(file)) {
    await delay(10);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function buildProvider(
  providerId: LocalProviderId,
  mode: ChildMode,
  controlDir: string,
  counter: { publishCalls: number; publishedIds: string[] },
): LocalProvider {
  return {
    provider: providerId,
    describe: () => ({
      provider: providerId,
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    }),
    freeze: (content, createdAt) => ({
      payloadVersion: 1,
      payload: { text: content, createdAt },
    }),
    verifyIdentity: async () => {
      throw new Error("the child never verifies an identity separately");
    },
    prepare: async (_credentials, target, signal): Promise<PreparedTarget> => {
      if (signal.aborted) {
        throw new Error("aborted before the session was prepared");
      }

      return {
        target: { ...target },
        publish: async (delivery, publishSignal): Promise<ProviderOutcome> => {
          counter.publishCalls++;
          counter.publishedIds.push(delivery.deliveryId);
          writeFileSync(
            path.join(controlDir, `${mode}.started`),
            delivery.deliveryId,
          );

          if (mode === "steady") {
            await delay(30);
            return { kind: "succeeded", remoteId: "at://fixture/steady", url: null };
          }

          if (mode === "hold") {
            await waitForFileInChild(path.join(controlDir, "release"));
            return { kind: "succeeded", remoteId: "at://fixture/held", url: null };
          }

          if (mode === "abort") {
            await waitForAbort(publishSignal);
            return { kind: "unknown", code: "ABORTED", writeDisposition: "unknown" };
          }

          // `silent`: the request was sent and the answer never arrives.
          await new Promise(() => {});
          return { kind: "unknown", code: "NEVER", writeDisposition: "unknown" };
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const [mode, stateHome, planId, controlDir, nowIso] = process.argv.slice(2) as [
    ChildMode,
    string,
    string,
    string,
    string,
  ];
  // Fixed to the parent's frozen-clock snapshot; an unset or invalid value
  // fails closed (the store and the plan refuse a non-representable clock)
  // instead of silently falling back to the wall clock.
  const now = (): Date => new Date(nowIso);
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort(new Error("signal"));
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const counter = { publishCalls: 0, publishedIds: [] as string[] };
  const store = createLocalFileStore(stateHome, { now });
  const providers = {
    bluesky: buildProvider("bluesky", mode, controlDir, counter),
    threads: buildProvider("threads", mode, controlDir, counter),
  };
  const write = (evidence: Partial<ChildEvidence> & { exitCode: number }): void => {
    writeFileSync(
      path.join(controlDir, `${mode}.json`),
      JSON.stringify({ mode, ...counter, ...evidence }, null, 2),
    );
  };

  try {
    const result = await withLocalWriteLock(stateHome, () =>
      executeLocalPlan(planId, {
        store,
        providers,
        resolveCredentials: async connection =>
          connection.target.provider === "bluesky"
            ? {
                provider: "bluesky",
                identifier: "child-handle",
                password: "child-password",
                host: "bsky.social",
              }
            : { provider: "threads", accessToken: "child-token" },
        signal: controller.signal,
        kind: "publish",
        now,
      }),
    );
    const exitCode = exitCodeForResult(result);

    write({
      exitCode,
      status: result.status,
      durability: result.durability,
      interrupted: result.interrupted === true,
      results: result.results.map(entry => ({
        provider: entry.provider,
        status: entry.status,
        attempts: entry.attempts,
        reused: entry.reused,
      })),
    });
    process.exit(exitCode);
  } catch (error) {
    const code = error instanceof CliError ? error.code : "UNEXPECTED";
    const exitCode = error instanceof CliError ? error.exitCode : 1;

    write({ exitCode, lockError: code });
    process.exit(exitCode);
  }
}

/**
 * `os.tmpdir()` on macOS is a symlinked path, so the entry is compared by name:
 * the tests import this module directly, and only the spawned child runs main.
 */
const invoked = process.argv[1] ?? "";

if (
  invoked.endsWith("local-execute-child.js") ||
  invoked.endsWith("local-execute-child.ts")
) {
  void main();
}
