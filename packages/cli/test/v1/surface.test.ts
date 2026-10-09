import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sandbox, stateRootExists, type Sandbox } from "./support/harness.js";

/**
 * The machine surface in a real Node process.
 *
 * `test/v1/loop.test.ts` drives `run()` in-process with an injected registry.
 * These cases instead bundle the published entry (`src/bin.ts`) and spawn it,
 * so the evidence covers argument scanning, exit codes and the lazy-init
 * boundary without any test-only seam. A preloaded guard records every
 * `net.Socket#connect` attempt, which is how "no socket was opened" is checked
 * rather than asserted.
 */

let workDir: string | undefined;
let bundle: string;
let guard: string;

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), "syndroo-cli-suite-"));
  // The entry sits one directory below the manifest, because `cliVersion()`
  // resolves `package.json` relative to the running file's parent.
  bundle = path.join(workDir, "dist", "syndroo.mjs");
  guard = path.join(workDir, "net-guard.mjs");
  await fs.mkdir(path.dirname(bundle), { recursive: true });

  await build({
    entryPoints: [fileURLToPath(new URL("../../src/bin.ts", import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    // Commander is CommonJS and calls `require("node:events")`. In an ESM
    // bundle esbuild's shim has no `require` until one is defined, so provide
    // the real resolver for the bundle's own URL.
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });

  // `cliVersion()` reads `package.json` next to the entry point, so the scratch
  // directory carries the current unpublished development candidate.
  await fs.writeFile(
    path.join(workDir, "package.json"),
    JSON.stringify({ name: "syndroo-surface-fixture", version: "0.7.0-rc.1" }),
  );

  await fs.writeFile(
    guard,
    [
      'import net from "node:net";',
      'import { appendFileSync } from "node:fs";',
      "const log = process.env.SYNDROO_SOCKET_LOG;",
      "if (log) {",
      "  const original = net.Socket.prototype.connect;",
      "  net.Socket.prototype.connect = function (...args) {",
      '    try { appendFileSync(log, "connect\\n"); } catch {}',
      "    return original.apply(this, args);",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
}, 60_000);

afterAll(async () => {
  if (workDir !== undefined) {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

type Spawned = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly socketLog: string;
};

function spawnCli(box: Sandbox, args: readonly string[]): Spawned {
  const socketLog = path.join(box.root, "sockets.log");
  const result = spawnSync(process.execPath, [bundle, ...args], {
    cwd: box.root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...box.env,
      SYNDROO_SOCKET_LOG: socketLog,
      NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    socketLog: existsSync(socketLog) ? "opened" : "",
  };
}

describe("syndroo machine surface (real process)", () => {
  it("--version prints the unpublished candidate and touches nothing", async () => {
    const box = await sandbox();

    try {
      const run = spawnCli(box, ["--version"]);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("0.7.0-rc.1");
      expect(run.stdout).not.toContain("0.0.0-unknown");
      expect(run.stderr).toBe("");
      expect(stateRootExists(box)).toBe(false);
      expect(run.socketLog).toBe("");
    } finally {
      await box.cleanup();
    }
  }, 60_000);

  it("--help lists the three v1 commands and touches nothing", async () => {
    const box = await sandbox();

    try {
      const run = spawnCli(box, ["--help"]);

      expect(run.status).toBe(0);
      // Required cheaply: the descriptions alone mention all three words, so
      // the assertion looks for real command lines in the Commands section.
      expect(run.stdout).toContain("Commands:");
      const commandLines = run.stdout
        .split("\n")
        .filter((line) => /^ {2}(connect|publish|status)\b/.test(line));
      expect(commandLines.map((line) => line.trim().split(" ")[0])).toEqual([
        "connect",
        "publish",
        "status",
      ]);
      expect(stateRootExists(box)).toBe(false);
      expect(run.socketLog).toBe("");
    } finally {
      await box.cleanup();
    }
  }, 60_000);

  it("per-command help documents the real options and touches nothing", async () => {
    const box = await sandbox();

    try {
      const expected: readonly (readonly [string, string])[] = [
        ["connect", "--from-env"],
        ["publish", "--dry-run"],
        ["status", "--operations"],
      ];

      for (const [command, option] of expected) {
        const run = spawnCli(box, [command, "--help"]);

        expect(run.status).toBe(0);
        expect(run.stdout).toContain(`Usage: syndroo ${command}`);
        expect(run.stdout).toContain(option);
        expect(run.stderr).toBe("");
        expect(run.socketLog).toBe("");
      }

      expect(stateRootExists(box)).toBe(false);
    } finally {
      await box.cleanup();
    }
  }, 60_000);

  it("a bare invocation answers from help and touches nothing", async () => {
    const box = await sandbox();

    try {
      const run = spawnCli(box, []);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("Usage");
      expect(stateRootExists(box)).toBe(false);
      expect(run.socketLog).toBe("");
    } finally {
      await box.cleanup();
    }
  }, 60_000);

  it("status --json returns exactly one overview envelope and creates no state", async () => {
    const box = await sandbox();

    try {
      const run = spawnCli(box, ["status", "--json"]);

      expect(run.status).toBe(0);
      const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);

      expect(lines).toHaveLength(1);
      const envelope = JSON.parse(lines[0] as string) as Record<string, any>;

      expect(envelope).toMatchObject({ protocolVersion: 1, operation: "status", ok: true, error: null });
      expect(envelope["result"]).toMatchObject({ type: "overview", initialized: false });
      // F3a: the built-in catalog answers without a config file, so the five
      // official providers are listed even on a machine that never ran Syndroo.
      // They are `unavailable` here because this scratch tree holds no provider
      // package; the ids come from the generated catalog alone.
      expect(
        (envelope["result"].providers as { provider: string }[]).map((view) => view.provider),
      ).toEqual(["bluesky", "devto", "linkedin", "mastodon", "threads"]);
      expect(stateRootExists(box)).toBe(false);
      expect(run.socketLog).toBe("");
    } finally {
      await box.cleanup();
    }
  }, 60_000);

  it("status --json --provider reports unavailable without a trusted catalog", async () => {
    const box = await sandbox();

    try {
      const run = spawnCli(box, ["status", "--json", "--provider", "fake"]);

      expect(run.status).toBe(0);
      const envelope = JSON.parse(run.stdout.trim()) as Record<string, any>;

      expect(envelope["result"]).toMatchObject({
        type: "provider",
        provider: { provider: "fake", availability: "unavailable" },
      });
      expect(stateRootExists(box)).toBe(false);
    } finally {
      await box.cleanup();
    }
  }, 60_000);

  it("an unknown command fails as usage without echoing argv", async () => {
    const box = await sandbox();

    try {
      const run = spawnCli(box, ["frobnicate", "--token", "SECRET-CANARY"]);

      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("syndroo:");
      expect(run.stderr).not.toContain("SECRET-CANARY");
      expect(run.stderr).not.toContain("frobnicate");
      expect(stateRootExists(box)).toBe(false);
    } finally {
      await box.cleanup();
    }
  }, 60_000);
});
