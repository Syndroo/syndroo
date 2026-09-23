#!/usr/bin/env node
/**
 * Disposable subprocess fixtures for the bounded-run watchdog regressions.
 *
 * These are deliberately tiny and self-contained: the watchdog tests spawn this
 * file directly with `node`, so it imports nothing outside Node built-ins and
 * never touches the Worker package. It only exists to be started, to report its
 * own pid, and to exit (or refuse to exit) in a controlled way.
 *
 * Usage: node watchdog-fixtures.ts --mode <exit|exit-with-descendant|hang|hang-tree|hang-ignore-term> [--code N]
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface FixtureOptions {
  readonly mode: string;
  readonly code: number;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): FixtureOptions {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (key !== undefined && key.startsWith("--") && value !== undefined) {
      flags.set(key.slice(2), value);
    }
  }

  return {
    mode: flags.get("mode") ?? "exit",
    code: Number(flags.get("code") ?? "0"),
    quiet: flags.has("quiet"),
  };
}

const options = parseArgs(process.argv.slice(2));

function report(line: string): void {
  if (!options.quiet) {
    process.stdout.write(`${line}\n`);
  }
}

function hang(): void {
  // A referenced interval keeps the process alive indefinitely.
  setInterval(() => undefined, 1_000);
}

report(`fixture mode=${options.mode} pid=${String(process.pid)}`);

switch (options.mode) {
  case "exit": {
    report(`fixture exit ${String(options.code)}`);
    process.exit(options.code);
    break;
  }
  case "hang": {
    hang();
    break;
  }
  case "hang-ignore-term": {
    // Proves the watchdog escalates to SIGKILL after its bounded grace period.
    process.on("SIGTERM", () => undefined);
    hang();
    break;
  }
  case "hang-tree": {
    const descendant = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--mode", "hang", "--quiet"],
      { stdio: "ignore" },
    );
    report(`fixture descendant=${String(descendant.pid)}`);
    hang();
    break;
  }
  case "exit-with-descendant": {
    // The parent leaves first, so only an owned-group cleanup can reap this
    // descendant; the original exit status must still be preserved.
    const descendant = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--mode", "hang", "--quiet"],
      { stdio: "ignore" },
    );
    report(`fixture descendant=${String(descendant.pid)}`);
    report(`fixture exit ${String(options.code)}`);
    process.exit(options.code);
    break;
  }
  default: {
    process.stderr.write(`watchdog-fixtures: unknown mode ${options.mode}\n`);
    process.exit(64);
  }
}
