#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PACKAGE_PATH,
  planWorkerBundle,
  resolveRepositoryRoot,
} from "./package-support.js";

const repositoryRoot = resolveRepositoryRoot(process.cwd());
const plan = planWorkerBundle(repositoryRoot);
const packageDirectory = resolve(repositoryRoot, PACKAGE_PATH);
const wranglerBinary = resolve(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

// A stale `dist/` is the failure mode this script exists to remove: the
// published package must never carry an older bundle, an older source map, or
// an older deploy entry point than the source it was built from.
await rm(plan.outputDirectory, { recursive: true, force: true });

const exitCode = await runWrangler(plan.wranglerArguments);

if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  await sanitizeOutput(plan.outputDirectory);
  console.log(`Worker bundle written to ${plan.outputDirectory}`);
}

// Wrangler writes the absolute build directory into the source map and drops a
// timestamped `README.md` next to the bundle. Neither belongs in a published
// artifact: the absolute path leaks the build machine, and the README is not
// reproducible. Sources are already relative to the source map location, so an
// empty `sourceRoot` keeps them resolvable.
async function sanitizeOutput(outputDirectory: string): Promise<void> {
  const sourceMapPath = resolve(outputDirectory, "index.js.map");

  if (existsSync(sourceMapPath)) {
    const text = await readFile(sourceMapPath, "utf8");
    const sanitized = text.replace(
      /("sourceRoot"\s*:\s*)"(?:[^"\\]|\\.)*"/,
      '$1""',
    );

    if (sanitized !== text) {
      await writeFile(sourceMapPath, sanitized, "utf8");
    }
  }

  await rm(resolve(outputDirectory, "README.md"), { force: true });
}

function runWrangler(args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(wranglerBinary, [...args], {
      cwd: packageDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`wrangler exited after signal ${signal}`));
        return;
      }

      resolvePromise(code ?? 1);
    });
  });
}
