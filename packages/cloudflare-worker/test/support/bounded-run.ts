#!/usr/bin/env node
/**
 * Bounded external watchdog for long-running test commands.
 *
 * The Cloudflare Workers Vitest pool starts a fresh Miniflare/workerd instance
 * per test file and its worker startup path has no timeout, so a stalled
 * readiness handshake leaves Vitest blocked forever with no output and no exit
 * code. This wrapper does not change the command under test: it runs it in its
 * own process group, forwards output verbatim, and cleans the whole group up.
 *
 * Termination rules:
 * - Exactly one terminal reason wins: the child's natural exit, the deadline or
 *   a forwarded signal. It latches immediately and clears the deadline, so a
 *   natural exit keeps its own code even while the descendant grace and the
 *   final snapshot are still running.
 * - The owned process group is always cleaned before the result is reported:
 *   SIGTERM, a bounded grace period, SIGKILL. A parent that exits first
 *   therefore still has its descendants reaped.
 * - Diagnostics own separate process groups, are bounded by a hard deadline and
 *   an output cap, are capped in count, are cancelled when the run finishes, and
 *   can never hold the runner open or change the chosen status. Their groups are
 *   killed on every settle, including a normal exit that left descendants.
 * - Only processes in the owned group are described; no environment is read.
 *
 * Usage (Node 22.6+ and 24+ run TypeScript directly via type stripping):
 *   node test/support/bounded-run.ts --timeout-ms 900000 --label full-suite \
 *     --log /tmp/full-suite.log -- <cmd> [args...]
 *
 * Exit: the child's exit code, 124 when the deadline fired, 127 when the child
 * could not be spawned, 128+signal when the watchdog itself was signalled, 64
 * on misuse.
 */
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { constants as osConstants } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EXIT_MISUSE = 64;
export const EXIT_DEADLINE = 124;
export const EXIT_SPAWN_FAILURE = 127;

/** Default bound for every diagnostic and snapshot subprocess. */
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 5_000;
/** Upper bound for one diagnostic stream. */
const DIAGNOSTIC_MAX_BUFFER = 64 * 1024;
/** Maximum stack samples per run, so diagnostics cannot fan out without bound. */
const DIAGNOSTIC_MAX_TARGETS = 4;

export interface BoundedRunOptions {
  /** Command and arguments to run under the watchdog. */
  readonly command: readonly [string, ...string[]];
  /** Deadline after which the owned process group is terminated. */
  readonly timeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL for the owned group. */
  readonly killGraceMs?: number;
  /** Liveness heartbeat interval; 0 disables it. */
  readonly heartbeatMs?: number;
  /** Seconds to sample an owned stack for; 0 disables sampling. */
  readonly sampleSeconds?: number;
  /** Hard bound for each diagnostic and snapshot subprocess. */
  readonly diagnosticTimeoutMs?: number;
  /** Label included in watchdog lines. */
  readonly label?: string;
  /** Optional log file receiving the same lines as stdout. */
  readonly logPath?: string | undefined;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects non-finite or out-of-range budgets instead of silently disabling them. */
function requireBudget(value: number, name: string, minimum: number): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite number >= ${String(minimum)}`);
  }

  return value;
}

/** Signal name to number, so a signalled run still reports deterministically. */
function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) {
    return 1;
  }

  const number = (osConstants.signals as Record<string, number | undefined>)[
    signal
  ];

  return typeof number === "number" ? 128 + number : 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs one command under a finite deadline and resolves with its exit code.
 *
 * The returned promise always settles: a hung child, a hung diagnostic and a
 * missing executable all produce a deterministic code.
 */
export async function runBounded(options: BoundedRunOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const timeoutMs = requireBudget(options.timeoutMs, "timeoutMs", 1);
  const killGraceMs = requireBudget(options.killGraceMs ?? 10_000, "killGraceMs", 0);
  const heartbeatMs = requireBudget(options.heartbeatMs ?? 30_000, "heartbeatMs", 0);
  const sampleSeconds = requireBudget(options.sampleSeconds ?? 0, "sampleSeconds", 0);
  const diagnosticTimeoutMs = requireBudget(
    options.diagnosticTimeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
    "diagnosticTimeoutMs",
    1,
  );
  const label = options.label ?? "run";
  const logStream: WriteStream | undefined = options.logPath
    ? createWriteStream(options.logPath, { flags: "w" })
    : undefined;
  const startedAt = Date.now();
  /** Set once the run has finished: no further owned diagnostic may start. */
  let closed = false;
  /** In-flight diagnostic cancellers, so finishing never waits on one. */
  const pendingDiagnostics = new Set<() => void>();

  function emit(line: string): void {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const stamped = `[watchdog ${new Date().toISOString()} +${elapsed}s] ${line}`;
    stdout.write(`${stamped}\n`);
    logStream?.write(`${stamped}\n`);
  }

  emit(
    `label=${label} node=${process.version} cwd=${process.cwd()} ` +
      `timeout=${timeoutMs}ms command=${JSON.stringify(options.command)}`,
  );

  const [executable, ...args] = options.command;
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.write(chunk);
    logStream?.write(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr.write(chunk);
    logStream?.write(chunk);
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          emit(
            `alive; pid=${String(child.pid)} ` +
              `elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
          );
        }, heartbeatMs)
      : undefined;

  function killGroup(signal: NodeJS.Signals): void {
    if (child.pid === undefined) {
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      emit(
        `kill(${signal}) on group ${String(child.pid)} failed: ${describeError(error)}`,
      );
    }
  }

  /** True while the owned group still has a signallable member. */
  function groupAlive(): boolean {
    if (child.pid === undefined) {
      return false;
    }

    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs one diagnostic command in its own process group with a hard deadline
   * and an output cap. It always settles, even when the diagnostic spawns
   * children that keep the pipes open, and it kills its whole group on every
   * settle so a diagnostic that exits first cannot leak its descendants.
   */
  function runDiagnostic(
    command: string,
    commandArgs: readonly string[],
  ): Promise<string> {
    if (closed) {
      return Promise.resolve(`${command} skipped: watchdog is already closing`);
    }

    return new Promise((resolve) => {
      let settled = false;
      let text = "";
      let timer: NodeJS.Timeout | undefined;
      let diagnostic: ReturnType<typeof spawn> | undefined;
      let cancel: (() => void) | undefined;

      function settle(result: string): void {
        if (settled) {
          return;
        }

        settled = true;
        if (cancel !== undefined) {
          pendingDiagnostics.delete(cancel);
        }
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (diagnostic?.pid !== undefined) {
          // Kill the diagnostic's whole group: an already-exited leader may
          // still have left descendants holding the pipes.
          try {
            process.kill(-diagnostic.pid, "SIGKILL");
          } catch {
            // The diagnostic group is already gone.
          }
        }
        diagnostic?.stdout?.destroy();
        diagnostic?.stderr?.destroy();
        resolve(result);
      }

      try {
        diagnostic = spawn(command, [...commandArgs], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        resolve(`${command} unavailable: ${describeError(error)}`);
        return;
      }

      cancel = () => {
        settle(`${command} cancelled: watchdog is closing`);
      };
      pendingDiagnostics.add(cancel);

      function append(chunk: Buffer): void {
        if (settled) {
          return;
        }

        text += chunk.toString();

        if (text.length >= DIAGNOSTIC_MAX_BUFFER) {
          settle(
            `${command} output exceeded ${String(DIAGNOSTIC_MAX_BUFFER)} bytes; ` +
              `truncated:\n${text.slice(0, 2_048)}`,
          );
        }
      }

      diagnostic.stdout?.on("data", append);
      diagnostic.stderr?.on("data", append);
      diagnostic.on("error", (error: Error) => {
        settle(`${command} failed: ${describeError(error)}`);
      });
      diagnostic.on("exit", (code, signal) => {
        settle(
          code === 0 && signal === null
            ? text
            : `${command} exited code=${String(code)} signal=${String(signal)}\n${text}`,
        );
      });

      timer = setTimeout(() => {
        settle(
          `${command} timed out after ${String(diagnosticTimeoutMs)}ms; ` +
            `output so far:\n${text.slice(0, 2_048)}`,
        );
      }, diagnosticTimeoutMs);
    });
  }

  /**
   * Lists only the owned process group. Lines are filtered by process group id
   * before they are printed, so unrelated commands and their arguments are
   * never described, and no environment is read at all.
   */
  async function listGroupProcesses(): Promise<string> {
    if (child.pid === undefined) {
      return "";
    }

    const listing = await runDiagnostic("ps", [
      "-o",
      "pid=,ppid=,pgid=,stat=,command=",
      "-g",
      String(child.pid),
    ]);
    const groupId = String(child.pid);

    return listing
      .split("\n")
      .filter((line) => line.trim().split(/\s+/)[2] === groupId)
      .join("\n");
  }

  /** Optional evidence about where a hung group is blocked. */
  async function collectDiagnostics(): Promise<void> {
    const listing = await listGroupProcesses();
    emit(`process group before deadline:\n${listing}`);

    if (sampleSeconds <= 0 || child.pid === undefined) {
      return;
    }

    const targets = [
      child.pid,
      ...listing
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/.exec(line))
        .flatMap((match) => {
          if (match === null) {
            return [];
          }

          const pid = Number(match[1]);
          const command = match[4] ?? "";

          if (pid === child.pid || !/workerd/.test(command)) {
            return [];
          }

          return [pid];
        }),
    ].slice(0, DIAGNOSTIC_MAX_TARGETS);

    for (const pid of targets) {
      if (closed) {
        emit("diagnostics cancelled: watchdog is closing");
        return;
      }

      emit(`sampling pid ${pid} for ${sampleSeconds}s`);
      const output = await runDiagnostic("sample", [
        String(pid),
        String(sampleSeconds),
        "-mayDie",
      ]);
      emit(`stack sample for pid ${pid}:\n${output}`);
    }
  }

  return await new Promise<number>((resolve) => {
    let settled = false;
    /** Latched first terminal reason; cleanup runs exactly once. */
    let closing = false;
    let deadlineTimer: NodeJS.Timeout | undefined;

    function finish(code: number): void {
      if (settled) {
        return;
      }

      settled = true;
      closed = true;
      for (const cancel of [...pendingDiagnostics]) {
        cancel();
      }
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      process.removeListener("SIGHUP", forwardSignal);

      if (logStream) {
        logStream.end(() => resolve(code));
      } else {
        resolve(code);
      }
    }

    /** Final bounded snapshot, then the already chosen status. */
    async function finishWithSnapshot(code: number): Promise<void> {
      const snapshot = await listGroupProcesses();
      emit(`process group at exit:\n${snapshot}`);
      finish(code);
    }

    /**
     * Single closing path: clean the owned group, snapshot what is left, and
     * report the latched status. Descendants are reaped even when the group
     * leader exited first, and escalation still happens when the leader exits
     * during the grace period.
     */
    async function closeWith(code: number): Promise<void> {
      if (closing) {
        return;
      }

      closing = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }

      if (groupAlive()) {
        emit(`sending SIGTERM to process group ${String(child.pid)}`);
        killGroup("SIGTERM");
        await delay(killGraceMs);
        emit("grace period elapsed; sending SIGKILL to process group");
        killGroup("SIGKILL");
      }

      await finishWithSnapshot(code);
    }

    function forwardSignal(signal: NodeJS.Signals): void {
      emit(`received ${signal}; terminating process group ${String(child.pid)}`);
      void closeWith(signalExitCode(signal));
    }

    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    process.on("SIGHUP", forwardSignal);

    deadlineTimer = setTimeout(() => {
      emit(
        `DEADLINE REACHED after ${String(timeoutMs)}ms; terminating process group ` +
          `${String(child.pid)} (diagnostics run concurrently and never gate this)`,
      );

      // Diagnostics are optional evidence; they must not delay termination.
      void collectDiagnostics();
      void closeWith(EXIT_DEADLINE);
    }, timeoutMs);

    child.on("error", (error: Error) => {
      emit(`failed to start ${executable}: ${describeError(error)}`);
      void closeWith(EXIT_SPAWN_FAILURE);
    });

    child.on("exit", (code, signal) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      emit(
        `child exited code=${String(code)} signal=${String(signal)} elapsed=${elapsed}s`,
      );

      // A natural exit latches here, so a later deadline or signal can no
      // longer change the reported status; cleanup still reaps descendants.
      void closeWith(code ?? signalExitCode(signal));
    });
  });
}

function fail(message: string): never {
  process.stderr.write(`bounded-run: ${message}\n`);
  process.exit(EXIT_MISUSE);
}

function parseNumber(
  flags: ReadonlyMap<string, string>,
  key: string,
  fallback: string,
  minimum: number,
): number {
  const raw = flags.get(key) ?? fallback;
  const value = Number(raw);

  if (!Number.isFinite(value) || value < minimum) {
    fail(`--${key} must be a finite number >= ${String(minimum)}`);
  }

  return value;
}

function parseOptions(argv: readonly string[]): BoundedRunOptions {
  const separator = argv.indexOf("--");

  if (separator === -1 || separator === argv.length - 1) {
    fail("usage: bounded-run.ts [options] -- <cmd> [args...]");
  }

  const flags = new Map<string, string>();

  for (let index = 0; index < separator; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (key === undefined || !key.startsWith("--") || value === undefined) {
      fail(`cannot parse option pair at index ${index}`);
    }

    flags.set(key.slice(2), value);
  }

  const command = argv.slice(separator + 1);
  const executable = command[0];

  if (executable === undefined || executable.length === 0) {
    fail("missing command after `--`");
  }

  return {
    command: [executable, ...command.slice(1)],
    timeoutMs: parseNumber(flags, "timeout-ms", "900000", 1),
    heartbeatMs: parseNumber(flags, "heartbeat-ms", "30000", 0),
    killGraceMs: parseNumber(flags, "kill-grace-ms", "10000", 0),
    sampleSeconds: parseNumber(flags, "sample-seconds", "0", 0),
    diagnosticTimeoutMs: parseNumber(
      flags,
      "diagnostic-timeout-ms",
      String(DEFAULT_DIAGNOSTIC_TIMEOUT_MS),
      1,
    ),
    label: flags.get("label") ?? "run",
    logPath: flags.get("log"),
  };
}

/** CLI entry point: only used when this file is executed directly. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const code = await runBounded(parseOptions(process.argv.slice(2)));
  process.exit(code);
}
