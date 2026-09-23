#!/usr/bin/env node
/**
 * Documented aggregate Worker test command.
 *
 * Runs the main Worker project first and then every dedicated project found on
 * disk, sequentially, each under the finite `bounded-run.ts` watchdog. Every
 * project exit status is recorded and the command fails if any project failed,
 * even when a later project passed.
 *
 * This file is executed directly by `node`, so it imports no sibling module.
 *
 * Usage: node test/support/run-worker-tests.ts [options]
 *   --list                print the discovered projects and exit
 *   --only <substring>    run only projects whose name contains the substring
 *   --timeout-ms <n>      per-project deadline (default 900000)
 *   --kill-grace-ms <n>   SIGTERM to SIGKILL grace (default 5000)
 *
 * Exit: 0 when every selected project passed, otherwise the first nonzero
 * project exit code (124 when a project hit its deadline).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repoRoot = resolve(packageRoot, "../..");
const watchdog = join(here, "bounded-run.ts");
const vitest = join(repoRoot, "node_modules/vitest/vitest.mjs");

interface Project {
  readonly name: string;
  readonly config: string;
}

interface Options {
  readonly list: boolean;
  readonly only: string | undefined;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
}

function fail(message: string): never {
  process.stderr.write(`run-worker-tests: ${message}\n`);
  process.exit(64);
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];

    if (key === undefined || !key.startsWith("--")) {
      fail(`unexpected argument ${String(key)}`);
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
      switches.add(key.slice(2));
      continue;
    }

    flags.set(key.slice(2), value);
    index += 1;
  }

  function budget(key: string, fallback: number, minimum: number): number {
    const raw = flags.get(key);
    const parsed = raw === undefined ? fallback : Number(raw);

    if (!Number.isFinite(parsed) || parsed < minimum) {
      fail(`--${key} must be a finite number >= ${String(minimum)}`);
    }

    return parsed;
  }

  return {
    list: switches.has("list"),
    only: flags.get("only"),
    timeoutMs: budget("timeout-ms", 900_000, 1),
    killGraceMs: budget("kill-grace-ms", 5_000, 0),
  };
}

/** The main project plus every dedicated configuration found on disk. */
function discoverProjects(): Project[] {
  const projects: Project[] = [{ name: "main", config: "vitest.config.ts" }];

  for (const entry of readdirSync(join(packageRoot, "test")).sort()) {
    if (entry.endsWith(".vitest.config.ts")) {
      projects.push({
        name: entry.replace(/\.vitest\.config\.ts$/u, ""),
        config: `test/${entry}`,
      });
    }
  }

  return projects;
}

/** Runs one project under the watchdog and resolves with its exit code. */
function runProject(project: Project, options: Options): Promise<number> {
  return new Promise((resolveProject) => {
    const child = spawn(
      process.execPath,
      [
        watchdog,
        "--timeout-ms",
        String(options.timeoutMs),
        "--kill-grace-ms",
        String(options.killGraceMs),
        "--heartbeat-ms",
        "30000",
        "--label",
        project.name,
        "--",
        process.execPath,
        vitest,
        "run",
        "--config",
        project.config,
      ],
      { cwd: packageRoot, stdio: "inherit" },
    );

    child.on("error", (error: Error) => {
      process.stderr.write(
        `run-worker-tests: cannot start ${project.name}: ${error.message}\n`,
      );
      resolveProject(127);
    });

    child.on("exit", (code, signal) => {
      if (code !== null) {
        resolveProject(code);
        return;
      }

      process.stderr.write(
        `run-worker-tests: ${project.name} ended with signal ${String(signal)}\n`,
      );
      resolveProject(1);
    });
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const projects = discoverProjects().filter(
    (project) =>
      options.only === undefined || project.name.includes(options.only),
  );

  if (options.list) {
    for (const project of projects) {
      process.stdout.write(`${project.name}\t${project.config}\n`);
    }

    return;
  }

  if (projects.length === 0) {
    fail("no project selected");
  }

  if (!existsSync(vitest)) {
    fail(`vitest not found at ${vitest}`);
  }

  const results: { name: string; code: number }[] = [];

  for (const project of projects) {
    process.stdout.write(
      `\n=== worker project: ${project.name} (${project.config}) ===\n`,
    );
    const code = await runProject(project, options);
    results.push({ name: project.name, code });
    process.stdout.write(
      `=== worker project ${project.name} exited ${String(code)} ===\n`,
    );
  }

  process.stdout.write("\n=== worker project summary ===\n");

  for (const result of results) {
    process.stdout.write(
      `${result.code === 0 ? "pass" : "FAIL"} ${result.name} (exit ${String(result.code)})\n`,
    );
  }

  const failed = results.filter((result) => result.code !== 0);

  if (failed.length > 0) {
    process.stdout.write(
      `${String(failed.length)}/${String(results.length)} projects failed\n`,
    );
    process.exit(failed[0]?.code ?? 1);
  }

  process.stdout.write(
    `${String(results.length)}/${String(results.length)} projects passed\n`,
  );
}

await main();
