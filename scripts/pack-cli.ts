#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { packCliArtifact } from "./cli-support.js";
import { resolveRepositoryRoot } from "./package-support.js";

/**
 * Produces the publishable CLI candidate at
 * `artifacts/syndroo-cli-<version>.tgz`.
 *
 * This packs; it never publishes. The tarball is rebuilt from source first, so
 * the artifact can never be older than the bundle beside it.
 */

const repositoryRoot = resolveRepositoryRoot(process.cwd());
const bundleScript = resolve(
  repositoryRoot,
  ".build",
  "scripts",
  "bundle-cli.js",
);

if (!existsSync(bundleScript)) {
  throw new Error(
    `Missing ${relative(repositoryRoot, bundleScript)}. Run \`npm run build:scripts\` first.`,
  );
}

const exitCode = await new Promise<number>((resolvePromise, reject) => {
  const child = spawn(process.execPath, [bundleScript], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`bundle-cli exited after signal ${signal}`));
      return;
    }

    resolvePromise(code ?? 1);
  });
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const packed = await packCliArtifact(repositoryRoot);

  console.log(`artifact: ${relative(repositoryRoot, packed.tarballPath)}`);
  console.log(`version: ${packed.version}`);
  console.log(`sha256: ${packed.sha256}`);
  console.log(`bytes: ${packed.bytes}`);
  console.log(`files: ${packed.files.length}`);
}
