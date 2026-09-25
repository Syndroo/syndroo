/**
 * Real-process entry for the T07 process tests.
 *
 * The parent compiles this module with the repository TypeScript into a
 * temporary tree and spawns it as a genuine node child. It imports the public
 * `@syndroo/cli` surface only (`run`, `createProcessIo`) and injects the
 * test-only provider overrides that no production flag, environment variable,
 * or config field can reach.
 *
 * The process boundary mirrors `src/bin.ts` on purpose: the same signal
 * controller and the same closed-pipe tolerance, so a signal, a kill, and a
 * closed stdout are exercised by real OS processes. `src/bin.ts` itself is
 * covered separately by tests that run `dist/bin.js` directly, because a copied
 * handler proves nothing about the shipped binary.
 *
 * Evidence is written to files under `controlDir`, never to stdout, so a test
 * can count content calls and read a final status even when the process is
 * signalled or killed.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  LocalProvider,
  LocalProviderId,
  PreparedTarget,
  ProviderOutcome,
} from "@syndroo/core";
import { createProcessIo, run } from "@syndroo/cli";

export type PublishMode = "success" | "hold" | "abort";

export interface ProcessSpec {
  /** The CLI argv the child runs, without `node` or this entry. */
  readonly argv: readonly string[];
  /** Directory for evidence and control files (created by the parent). */
  readonly controlDir: string;
  /** What one content request does. Defaults to an immediate success. */
  readonly publishMode?: PublishMode;
  /** Stable ids the fake identity lookup reports per provider. */
  readonly targetIds?: Partial<Record<LocalProviderId, string>>;
}

const DEFAULT_TARGET_IDS: Readonly<Record<LocalProviderId, string>> = {
  bluesky: "did:plc:process-fixture",
  threads: "threads-process-fixture",
};

const CONTENT_CALLS_FILE = "content-calls.jsonl";
const STARTED_FILE = "publish-started";
const RELEASE_FILE = "release";
const EVIDENCE_FILE = "entry.json";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFile(file: string): Promise<void> {
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

function readSpec(): ProcessSpec {
  const specPath = process.argv[2] ?? "";
  const parsed = JSON.parse(readFileSync(specPath, "utf8")) as ProcessSpec;

  mkdirSync(parsed.controlDir, { recursive: true });
  return parsed;
}

function buildProvider(
  providerId: LocalProviderId,
  spec: ProcessSpec,
): LocalProvider {
  const controlDir = spec.controlDir;
  const targetId = spec.targetIds?.[providerId] ?? DEFAULT_TARGET_IDS[providerId];
  const mode = spec.publishMode ?? "success";

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
    verifyIdentity: async () => ({ targetId }),
    prepare: async (_credentials, target, signal): Promise<PreparedTarget> => {
      if (signal.aborted) {
        throw new Error("aborted before the session was prepared");
      }

      return {
        target: { ...target },
        publish: async (delivery, publishSignal): Promise<ProviderOutcome> => {
          // The call is recorded before anything can block, so a signalled or
          // killed child still leaves an exact count behind.
          appendFileSync(
            path.join(controlDir, CONTENT_CALLS_FILE),
            `${JSON.stringify({
              provider: providerId,
              deliveryId: delivery.deliveryId,
            })}\n`,
          );
          writeFileSync(path.join(controlDir, STARTED_FILE), delivery.deliveryId);

          if (mode === "hold") {
            await waitForFile(path.join(controlDir, RELEASE_FILE));
            return {
              kind: "succeeded",
              remoteId: `at://fixture/${delivery.deliveryId.slice(0, 8)}`,
              url: null,
            };
          }

          if (mode === "abort") {
            await waitForAbort(publishSignal);
            return {
              kind: "unknown",
              code: "ABORTED",
              writeDisposition: "unknown",
            };
          }

          return {
            kind: "succeeded",
            remoteId: `at://fixture/${delivery.deliveryId.slice(0, 8)}`,
            url: null,
          };
        },
      };
    },
  };
}

/** A closed consumer is not a crash; the shipped bin does the same. */
function tolerateClosedPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(process.exitCode === 0 ? 1 : (process.exitCode ?? 1));
    }

    throw error;
  });
}

async function main(): Promise<void> {
  const spec = readSpec();
  const controller = new AbortController();
  let stoppedBy: NodeJS.Signals | undefined;

  const stop = (signal: NodeJS.Signals): void => {
    stoppedBy = signal;
    controller.abort(new Error(`stopped by ${signal}`));
  };

  process.once("SIGINT", () => {
    stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    stop("SIGTERM");
  });
  tolerateClosedPipe(process.stdout);
  tolerateClosedPipe(process.stderr);

  const providers: Readonly<Record<LocalProviderId, LocalProvider>> = {
    bluesky: buildProvider("bluesky", spec),
    threads: buildProvider("threads", spec),
  };

  const code = await run(spec.argv, createProcessIo(controller.signal), {
    providers,
  });
  const exitCode = stoppedBy === undefined ? code : 130;

  writeFileSync(
    path.join(spec.controlDir, EVIDENCE_FILE),
    `${JSON.stringify(
      {
        exitCode,
        reported: code,
        stoppedBy: stoppedBy ?? null,
        argv: spec.argv,
      },
      null,
      2,
    )}\n`,
  );

  process.exitCode = exitCode;
}

const invoked = process.argv[1] ?? "";

if (
  invoked.endsWith("process-entry.js") ||
  invoked.endsWith("process-entry.ts")
) {
  void main();
}
