/**
 * Bounded-run watchdog regressions (Node host, disposable subprocesses).
 *
 * Every case runs the real `support/bounded-run.ts` against the disposable
 * fixtures in `support/watchdog-fixtures.ts`, so the evidence is the observed
 * exit status, the elapsed time and the survival of owned or unrelated
 * processes rather than a code reading. Fake `ps`/`sample` programs are used
 * through an isolated PATH entry to prove that hanging diagnostics cannot hold
 * the runner open.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = resolve(fileURLToPath(import.meta.url), "..");
const packageRoot = resolve(here, "..");
const watchdog = resolve(here, "support/bounded-run.ts");
const fixtures = resolve(here, "support/watchdog-fixtures.ts");

const EXIT_DEADLINE = 124;
const EXIT_SPAWN_FAILURE = 127;

interface WatchdogResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

interface WatchdogInvocation {
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

function fixtureArgs(mode: string, code?: number): string[] {
  return code === undefined
    ? ["--mode", mode]
    : ["--mode", mode, "--code", String(code)];
}

/** Runs the watchdog CLI and waits for it to settle on its own. */
async function runWatchdog(
  invocation: WatchdogInvocation,
): Promise<WatchdogResult> {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [watchdog, ...invocation.args], {
    cwd: packageRoot,
    env: invocation.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.on("exit", (exitCode, exitSignal) => {
      resolveExit({ code: exitCode, signal: exitSignal });
    });
  });

  return { code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt };
}

function ownedArgs(options: {
  readonly mode: string;
  readonly code?: number;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly extra?: readonly string[];
}): string[] {
  return [
    "--timeout-ms",
    String(options.timeoutMs),
    "--kill-grace-ms",
    String(options.killGraceMs),
    "--heartbeat-ms",
    "0",
    ...(options.extra ?? []),
    "--",
    process.execPath,
    fixtures,
    ...fixtureArgs(options.mode, options.code),
  ];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  budgetMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 50);
    });
  }

  return predicate();
}

function reportedPids(stdout: string): {
  readonly parent: number | undefined;
  readonly descendant: number | undefined;
} {
  const parent = /fixture mode=\S+ pid=(\d+)/.exec(stdout);
  const descendant = /fixture descendant=(\d+)/.exec(stdout);

  return {
    parent: parent === null ? undefined : Number(parent[1]),
    descendant: descendant === null ? undefined : Number(descendant[1]),
  };
}

/** Isolated PATH entry holding hanging fake diagnostics. */
function createHangingDiagnosticsDir(): {
  readonly dir: string;
  readonly markers: readonly string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "t9a-diagnostics-"));
  const markers = [join(dir, "ps-invoked"), join(dir, "sample-invoked")];

  for (const [name, marker] of [
    ["ps", markers[0]],
    ["sample", markers[1]],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n: > "${marker}"\nexec sleep 300\n`);
    chmodSync(path, 0o755);
  }

  return { dir, markers };
}

describe("bounded-run watchdog", () => {
  it("preserves a natural exit code and forwards child output", async () => {
    const result = await runWatchdog({
      args: ownedArgs({
        mode: "exit",
        code: 7,
        timeoutMs: 30_000,
        killGraceMs: 1_000,
      }),
    });

    expect(result.signal).toBeNull();
    expect(result.code).toBe(7);
    expect(result.stdout).toContain("fixture exit 7");
    expect(result.stdout).toContain("child exited code=7");
  });

  it("preserves a successful exit", async () => {
    const result = await runWatchdog({
      args: ownedArgs({
        mode: "exit",
        code: 0,
        timeoutMs: 30_000,
        killGraceMs: 1_000,
      }),
    });

    expect(result.code).toBe(0);
  });

  it("reports a spawn failure instead of hanging", async () => {
    const result = await runWatchdog({
      args: [
        "--timeout-ms",
        "30000",
        "--kill-grace-ms",
        "1000",
        "--heartbeat-ms",
        "0",
        "--",
        join(tmpdir(), "t9a-missing-executable-v050"),
      ],
    });

    expect(result.code).toBe(EXIT_SPAWN_FAILURE);
    expect(result.stdout).toContain("failed to start");
    expect(result.elapsedMs).toBeLessThan(20_000);
  });

  it("kills a hung group at the deadline and reaps descendants", async () => {
    const result = await runWatchdog({
      args: ownedArgs({ mode: "hang-tree", timeoutMs: 700, killGraceMs: 400 }),
    });

    expect(result.code).toBe(EXIT_DEADLINE);
    expect(result.elapsedMs).toBeLessThan(20_000);
    expect(result.stdout).toContain("DEADLINE REACHED");

    const { parent, descendant } = reportedPids(result.stdout);
    expect(parent).toBeDefined();
    expect(descendant).toBeDefined();
    expect(await waitFor(() => !isAlive(descendant as number))).toBe(true);
    expect(await waitFor(() => !isAlive(parent as number))).toBe(true);
  });

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    const result = await runWatchdog({
      args: ownedArgs({
        mode: "hang-ignore-term",
        timeoutMs: 700,
        killGraceMs: 500,
      }),
    });

    expect(result.code).toBe(EXIT_DEADLINE);
    expect(result.stdout).toContain("grace period elapsed; sending SIGKILL");

    const { parent } = reportedPids(result.stdout);
    expect(parent).toBeDefined();
    expect(await waitFor(() => !isAlive(parent as number))).toBe(true);
  });

  it("reaps a descendant whose parent exits first and keeps the exit code", async () => {
    const result = await runWatchdog({
      args: ownedArgs({
        mode: "exit-with-descendant",
        code: 9,
        timeoutMs: 30_000,
        killGraceMs: 400,
      }),
    });

    expect(result.code).toBe(9);

    const { descendant } = reportedPids(result.stdout);
    expect(descendant).toBeDefined();
    expect(await waitFor(() => !isAlive(descendant as number))).toBe(true);
  });

  it("stays bounded when diagnostics hang", async () => {
    const { dir, markers } = createHangingDiagnosticsDir();
    const result = await runWatchdog({
      args: ownedArgs({
        mode: "hang",
        timeoutMs: 700,
        killGraceMs: 400,
        extra: ["--sample-seconds", "1", "--diagnostic-timeout-ms", "500"],
      }),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.code).toBe(EXIT_DEADLINE);
    expect(result.elapsedMs).toBeLessThan(30_000);
    expect(result.stdout).toContain("process group before deadline");

    for (const marker of markers) {
      expect(await waitFor(() => existsSync(marker))).toBe(true);
    }
  });

  it("reaps descendants left behind by a diagnostic that exits first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9a-diagnostics-tree-"));
    const pidFile = join(dir, "diagnostic-descendant.pid");
    const psPath = join(dir, "ps");

    // The fake diagnostic starts a long-lived descendant, records its pid and
    // exits successfully, leaving that descendant holding the output pipes.
    writeFileSync(
      psPath,
      `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\nexit 0\n`,
    );
    chmodSync(psPath, 0o755);
    const samplePath = join(dir, "sample");
    writeFileSync(samplePath, "#!/bin/sh\nexit 0\n");
    chmodSync(samplePath, 0o755);

    const result = await runWatchdog({
      args: ownedArgs({
        mode: "hang",
        timeoutMs: 700,
        killGraceMs: 400,
        extra: ["--diagnostic-timeout-ms", "1500"],
      }),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.code).toBe(EXIT_DEADLINE);
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);

    const descendant = Number(readFileSync(pidFile, "utf8").trim());

    expect(Number.isInteger(descendant)).toBe(true);
    expect(await waitFor(() => !isAlive(descendant))).toBe(true);
  });

  it("cleans the owned group when the watchdog is signalled", async () => {
    const child = spawn(
      process.execPath,
      [
        watchdog,
        ...ownedArgs({
          mode: "hang-tree",
          timeoutMs: 60_000,
          killGraceMs: 400,
        }),
      ],
      { cwd: packageRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    expect(await waitFor(() => /fixture descendant=(\d+)/.test(stdout))).toBe(
      true,
    );
    expect(child.pid).toBeDefined();
    process.kill(child.pid as number, "SIGTERM");

    const { code } = await new Promise<{ code: number | null }>(
      (resolveExit) => {
        child.on("exit", (exitCode) => {
          resolveExit({ code: exitCode });
        });
      },
    );

    expect(code).toBe(143);

    const { parent, descendant } = reportedPids(stdout);
    expect(parent).toBeDefined();
    expect(descendant).toBeDefined();
    expect(await waitFor(() => !isAlive(descendant as number))).toBe(true);
    expect(await waitFor(() => !isAlive(parent as number))).toBe(true);
  });

  it("does not kill processes outside the owned group", async () => {
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );

    try {
      expect(unrelated.pid).toBeDefined();

      const result = await runWatchdog({
        args: ownedArgs({ mode: "hang", timeoutMs: 700, killGraceMs: 400 }),
      });

      expect(result.code).toBe(EXIT_DEADLINE);
      expect(isAlive(unrelated.pid as number)).toBe(true);
    } finally {
      if (unrelated.pid !== undefined) {
        try {
          process.kill(-unrelated.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});

describe("bounded-run options", () => {
  it("rejects non-finite or zero budgets before spawning", async () => {
    const { runBounded } = await import("./support/bounded-run.js");

    await expect(
      runBounded({ command: [process.execPath, "-e", "0"], timeoutMs: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      runBounded({
        command: [process.execPath, "-e", "0"],
        timeoutMs: Number.NaN,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      runBounded({
        command: [process.execPath, "-e", "0"],
        timeoutMs: 1_000,
        diagnosticTimeoutMs: 0,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      runBounded({
        command: [process.execPath, "-e", "0"],
        timeoutMs: 1_000,
        killGraceMs: -1,
      }),
    ).rejects.toThrow(RangeError);
  });
});
