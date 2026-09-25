#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { builtinModules } from "node:module";

import { build } from "esbuild";

import {
  CLI_BUNDLE_ENTRIES,
  cliDirectory,
  cliDistDirectory,
  collectDisallowedSpecifiers,
  makeExecutable,
  vendorCliDeclarations,
} from "./cli-support.js";
import { writeCliThirdPartyNotices } from "./cli-licenses.js";
import { resolveRepositoryRoot } from "./package-support.js";

/**
 * Builds the self-contained `@syndroo/cli` artifact.
 *
 * Two things ship and nothing else: the bundled command/library JavaScript, and
 * the declarations for the public surface. The SDK and the private workspace
 * packages are compiled in, so the tarball has no runtime dependency on a
 * package that is not published.
 *
 * A stale `dist/` is the failure mode this script exists to remove, exactly as
 * in the Worker bundle: the published package must never carry an older bundle
 * than the source it was built from.
 */

const repositoryRoot = resolveRepositoryRoot(process.cwd());
const packageDirectory = cliDirectory(repositoryRoot);
const distDirectory = cliDistDirectory(repositoryRoot);
let metafile: unknown;

/** Bare built-in names mapped to their `node:` form. */
const NODE_BUILTIN_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  builtinModules
    .filter((name) => !name.startsWith("node:"))
    .map((name) => [name, `node:${name}`]),
);

await rm(distDirectory, { recursive: true, force: true });

const typeExitCode = await run(tscBinary(repositoryRoot), [
  "-p",
  resolve(packageDirectory, "tsconfig.build.json"),
]);

if (typeExitCode !== 0) {
  process.exitCode = typeExitCode;
} else {
  await bundle();
  await makeExecutable(resolve(distDirectory, "bin.js"));
  await vendorCliDeclarations(repositoryRoot, distDirectory);
  await writeNotices();
  await assertSelfContained();
  console.log(`CLI bundle written to ${distDirectory}`);
}

async function bundle(): Promise<void> {
  const result = await build({
    entryPoints: CLI_BUNDLE_ENTRIES.map((entry) => ({
      in: resolve(packageDirectory, entry.source),
      out: entry.output.replace(/\.js$/u, ""),
    })),
    outdir: distDirectory,
    absWorkingDir: packageDirectory,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    // The metafile is the licence input: it lists every module that actually
    // reached the bundle, so a new transitive dependency cannot ship unnoticed.
    metafile: true,
    // A dependency without an `exports` map can still ship an ESM build next to
    // a UMD one (`jsonc-parser` does). esbuild's Node default resolves `main`
    // first, which pulls in the UMD file and leaves its internal
    // `require("./impl/format")` calls to fail at runtime in ESM output.
    // Preferring the `module` entry keeps bundling to real ESM sources.
    mainFields: ["module", "main"],
    // A dependency may import a Node built-in with its bare name (`crypto`),
    // which esbuild leaves external. The published artifact must not depend on
    // Node resolving that bare name, so every built-in is rewritten to the
    // explicit `node:` form at build time.
    alias: NODE_BUILTIN_ALIASES,
    // One file per entry point keeps the published layout predictable and the
    // dynamic provider imports inlined rather than split into chunks.
    splitting: false,
    logLevel: "warning",
  });

  metafile = result.metafile;
}

/**
 * Third-party notices from the real bundle metadata.
 *
 * The Syndroo SDK, core, and provider packages are repository-owned and are
 * covered by the LICENSE and NOTICE files shipped beside the notices.
 */
async function writeNotices(): Promise<void> {
  const licensesDirectory = resolve(packageDirectory, "licenses");
  const written = await writeCliThirdPartyNotices({
    metafile: (metafile ?? {}) as {
      readonly inputs?: Readonly<Record<string, unknown>>;
    },
    workingDirectory: packageDirectory,
    repositoryRoot,
    distDirectory,
    packageName: "@syndroo/cli",
    supplementPath: resolve(
      licensesDirectory,
      "third-party-license-supplements.json",
    ),
    supplementDirectory: licensesDirectory,
  });

  console.log(
    `third-party notices: ${String(written.packages.length)} bundled package(s)`,
  );
  console.log(`  ${written.packages.join(", ")}`);
}

/**
 * The artifact is only self-contained if nothing outside the bundle is
 * imported. This is the check that would have caught a private workspace
 * import reaching the tarball.
 */
async function assertSelfContained(): Promise<void> {
  const violations = await collectDisallowedSpecifiers(distDirectory, [
    ".js",
    ".d.ts",
  ]);

  if (violations.length === 0) {
    return;
  }

  const detail = violations
    .map((violation) => `  ${violation.specifier} (${violation.file})`)
    .join("\n");

  throw new Error(
    [
      "The CLI bundle still imports specifiers that are not part of the artifact:",
      detail,
      "Bundle them, or vendor their declarations, before publishing.",
    ].join("\n"),
  );
}

function tscBinary(root: string): string {
  return resolve(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
}

function run(executable: string, args: readonly string[]): Promise<number> {
  if (!existsSync(executable)) {
    return Promise.reject(new Error(`Missing ${executable}.`));
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${executable} exited after signal ${signal}`));
        return;
      }

      resolvePromise(code ?? 1);
    });
  });
}
