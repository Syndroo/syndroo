import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type {
  LocalProvider,
  LocalProviderId,
  ProviderOutcome,
} from "@syndroo/core";
import { describe, expect, it } from "vitest";

import { parseArgs } from "../../src/args.js";
import type { CommandContext } from "../../src/commands/context.js";
import { runAuthSet, runAuthStatus } from "../../src/commands/local/auth.js";
import { runDoctorLocal } from "../../src/commands/local/doctor.js";
import { runInit } from "../../src/commands/local/init.js";
import { runProvidersList } from "../../src/commands/local/providers.js";
import { runPublish } from "../../src/commands/local/publish.js";
import type { LocalCommandOutcome } from "../../src/commands/local/shared.js";
import { CliError } from "../../src/cli-error.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import type { CliIo } from "../../src/io.js";
import type { LocalRunOverrides } from "../../src/local/composition.js";
import type {
  LocalExecutionResult,
  LocalPreviewResult,
} from "../../src/local/results.js";
import { Reporter } from "../../src/output.js";

/**
 * The documented local workflow, executed against the real handlers with a
 * temporary HOME and a fake provider set.
 *
 * This is not a substitute for the packaged end-to-end run: it drives the
 * command handlers directly, so argv parsing is the only part of the entrypoint
 * it skips. The providers are doubles, so every assertion about content
 * requests is exact and no socket is opened.
 */

const BLUESKY_TARGET = "did:plc:manualfixture";

interface ManualHarness {
  readonly root: string;
  readonly overrides: LocalRunOverrides;
  readonly publishCalls: ProviderOutcome[];
  context(argv: readonly string[]): CommandContext;
  stderr(): string;
  cleanup(): void;
}

function sink(lines: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
}

function fakeProvider(
  provider: LocalProviderId,
  calls: ProviderOutcome[],
): LocalProvider {
  const targetId =
    provider === "bluesky" ? BLUESKY_TARGET : "threads-manualfixture";

  return {
    provider,
    describe: () => ({
      provider,
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
    }),
    freeze: (content, createdAt) => ({
      payloadVersion: 1,
      payload: { text: content, createdAt },
    }),
    verifyIdentity: async () => ({ targetId }),
    prepare: async (_credentials, target) => ({
      target,
      publish: async delivery => {
        const outcome: ProviderOutcome = {
          kind: "succeeded",
          remoteId: `at://${targetId}/${delivery.deliveryId.slice(0, 8)}`,
          url: null,
        };

        calls.push(outcome);

        return outcome;
      },
    }),
  };
}

function createHarness(): ManualHarness {
  const root = mkdtempSync(path.join(tmpdir(), "syndroo-manual-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const publishCalls: ProviderOutcome[] = [];
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_STATE_HOME: path.join(root, ".local", "state"),
    BLUESKY_IDENTIFIER: "manual.bsky.social",
    BLUESKY_PASSWORD: "APP_PASSWORD_PLACEHOLDER",
    THREADS_ACCESS_TOKEN: "ACCESS_TOKEN_PLACEHOLDER",
  };
  const io: CliIo = {
    stdin: Readable.from([]),
    stdout: sink(stdout),
    stderr: sink(stderr),
    env,
    cwd: root,
    stdinIsTty: false,
    stdoutIsTty: false,
    hasTty: () => false,
    readTtyLine: () => undefined,
    signal: new AbortController().signal,
  };
  const overrides: LocalRunOverrides = {
    providers: {
      bluesky: fakeProvider("bluesky", publishCalls),
      threads: fakeProvider("threads", publishCalls),
    },
  };

  return {
    root,
    overrides,
    publishCalls,
    context: argv => {
      const parsed = parseArgs(argv);

      return {
        parsed,
        io,
        reporter: new Reporter(io, parsed.flags.get("json") === true),
      };
    },
    stderr: () => stderr.join(""),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function rejectionOf(
  run: () => Promise<LocalCommandOutcome>,
): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

async function planFor(
  harness: ManualHarness,
  content: string,
): Promise<LocalPreviewResult> {
  const documentPath = path.join(harness.root, "post.json");

  writeFileSync(
    documentPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        key: "manual-fixture-001",
        content,
        platforms: ["bluesky"],
      },
      null,
      2,
    ),
  );

  const preview = await runPublish(
    harness.context([
      "publish",
      "--input",
      documentPath,
      "--dry-run",
      "--json",
    ]),
    harness.overrides,
  );

  expect(preview.ok).toBe(true);
  expect(preview.exitCode).toBe(EXIT_CODE.SUCCESS);

  return preview.result as LocalPreviewResult;
}

describe("the documented local workflow", () => {
  it("previews a frozen plan and executes that same plan once", async () => {
    const harness = createHarness();

    try {
      const init = await runInit(
        harness.context(["init", "--namespace", "manual"]),
        harness.overrides,
      );

      expect(init.ok).toBe(true);
      expect(init.result).toMatchObject({
        schemaVersion: 1,
        namespace: "manual",
      });

      // Documented step 1. `doctor --local` currently reports a failing runtime
      // check because `commands/local/doctor.ts` imports
      // `assertSupportedRuntime` from `local/state/store.ts`, which imports it
      // from `atomic.ts` but does not re-export it; the call is `undefined` at
      // runtime. Reported to root; the assertion stays so the fix is pinned.
      const doctor = await runDoctorLocal(
        harness.context(["doctor", "--local"]),
        harness.overrides,
      );

      expect(doctor.ok).toBe(true);

      const providers = await runProvidersList(
        harness.context(["providers", "list"]),
        harness.overrides,
      );
      const listed = (
        providers.result as {
          readonly providers: readonly { readonly provider: string }[];
        }
      ).providers.map(entry => entry.provider);

      expect(listed).toHaveLength(2);
      expect(listed).toEqual(expect.arrayContaining(["bluesky", "threads"]));

      const authSet = await runAuthSet(
        harness.context([
          "auth",
          "set",
          "bluesky",
          "--local",
          "--from-env",
          "--expect-account",
          BLUESKY_TARGET,
          "--yes",
          "--no-input",
        ]),
        harness.overrides,
      );

      expect(authSet.ok).toBe(true);
      expect(authSet.result).toMatchObject({
        provider: "bluesky",
        targetId: BLUESKY_TARGET,
        verified: true,
      });

      const status = await runAuthStatus(
        harness.context(["auth", "status", "--local"]),
        harness.overrides,
      );

      expect(status.ok).toBe(true);

      const content = "Manual fixture text for the documented workflow.";
      const preview = await planFor(harness, content);

      expect(preview.items).toHaveLength(1);
      expect(preview.items[0]).toMatchObject({
        provider: "bluesky",
        targetId: BLUESKY_TARGET,
        action: "publish",
        content,
        previousBinding: null,
      });
      expect(harness.stderr()).toContain("frozen createdAt");
      expect(harness.publishCalls).toHaveLength(0);

      const executed = await runPublish(
        harness.context([
          "publish",
          "--plan",
          preview.planId,
          "--yes",
          "--no-input",
          "--json",
        ]),
        harness.overrides,
      );

      expect(executed.ok).toBe(true);
      expect(executed.exitCode).toBe(EXIT_CODE.SUCCESS);

      const result = executed.result as LocalExecutionResult;

      expect(result.status).toBe("succeeded");
      expect(result.durability).toBe("committed");
      expect(result.results).toEqual([
        expect.objectContaining({
          provider: "bluesky",
          targetId: BLUESKY_TARGET,
          status: "succeeded",
          attempts: 1,
          writeDisposition: "applied",
        }),
      ]);
      expect(harness.publishCalls).toHaveLength(1);

      // A replay reports the original success and sends nothing.
      const replay = await runPublish(
        harness.context([
          "publish",
          "--plan",
          preview.planId,
          "--yes",
          "--no-input",
          "--json",
        ]),
        harness.overrides,
      );

      expect(replay.ok).toBe(true);
      expect(harness.publishCalls).toHaveLength(1);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a non-interactive execution without both confirmations", async () => {
    const harness = createHarness();

    try {
      await runInit(harness.context(["init"]), harness.overrides);
      await runAuthSet(
        harness.context([
          "auth",
          "set",
          "bluesky",
          "--local",
          "--from-env",
          "--expect-account",
          BLUESKY_TARGET,
          "--yes",
          "--no-input",
        ]),
        harness.overrides,
      );

      const preview = await planFor(harness, "Manual fixture text.");
      const error = await rejectionOf(() =>
        runPublish(
          harness.context(["publish", "--plan", preview.planId, "--json"]),
          harness.overrides,
        ),
      );

      expect(error.code).toBe("CONFIRMATION_REQUIRED");
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(harness.publishCalls).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });
});
