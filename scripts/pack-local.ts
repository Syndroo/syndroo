#!/usr/bin/env node
/**
 * `npm run pack:local`: write one tarball per public architecture-v1 package
 * into `artifacts/`.
 *
 * Two failures this replaces:
 *
 * 1. `npm pack --workspaces` also packs the private `@syndroo/core`, producing a
 *    `syndroo-core-*.tgz` that must never exist. The ten packages are named
 *    explicitly here, and the private Core package is never among them. A stray
 *    Core tarball left in `artifacts/` is reported, never deleted.
 * 2. Packing a tree that is only half-bumped ships a mixed-version set. Every
 *    packaged manifest is read first and must declare one shared version.
 *
 * Run with Node's type stripping:
 *
 *   node scripts/pack-local.ts
 *   node scripts/pack-local.ts --help
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARTIFACTS_DIRECTORY,
  publicPackageNames,
  sharedVersion,
  tarballName,
  type PackageVersion,
} from "./lib/local-release.ts";
import { ROOT, STAGES } from "./lib/v1-stages.ts";

const USAGE = `Usage: npm run pack:local

Packs the ten public @syndroo packages into ./${ARTIFACTS_DIRECTORY}/.
@syndroo/core is private and is never packed.
`;

/** The ten public stages, in build order. Core is the only one excluded. */
const PUBLIC_STAGES = STAGES.filter((stage) => stage.corePackage !== true);

/** Read the ten public manifests and enforce the single-version rule. */
async function resolveVersion(): Promise<string> {
  const manifests: PackageVersion[] = [];

  for (const stage of PUBLIC_STAGES) {
    const manifest = JSON.parse(
      await readFile(join(ROOT, "packages", stage.dir, "package.json"), "utf8"),
    ) as { name?: string; version?: string };

    if (manifest.name !== stage.name) {
      throw new Error(
        `Expected ${stage.name} in packages/${stage.dir}/package.json.`,
      );
    }

    manifests.push({ name: stage.name, version: manifest.version ?? "" });
  }

  return sharedVersion(manifests);
}

async function pack(): Promise<void> {
  const version = await resolveVersion();
  const artifactsDirectory = join(ROOT, ARTIFACTS_DIRECTORY);
  await mkdir(artifactsDirectory, { recursive: true });

  const workspaceArguments = PUBLIC_STAGES.flatMap((stage) => [
    "--workspace",
    stage.name,
  ]);
  const result = spawnSync(
    "npm",
    ["pack", ...workspaceArguments, "--pack-destination", ARTIFACTS_DIRECTORY],
    { cwd: ROOT, stdio: "inherit" },
  );

  if (result.status !== 0) {
    throw new Error(
      `npm pack failed with exit code ${String(result.status ?? "null")}.`,
    );
  }

  for (const name of publicPackageNames()) {
    const filePath = join(artifactsDirectory, tarballName(name, version));
    const info = await stat(filePath);
    console.log(`${filePath}  ${info.size} bytes`);
  }

  await warnOnStrayCoreTarball(artifactsDirectory);
}

/**
 * A `syndroo-core-*.tgz` in `artifacts/` is a tarball that must never be
 * published. Name it and leave it exactly where it is.
 */
async function warnOnStrayCoreTarball(artifactsDirectory: string): Promise<void> {
  for (const entry of await readdir(artifactsDirectory)) {
    if (/^syndroo-core-.*\.tgz$/u.test(entry)) {
      console.warn(
        `warning: ${join(ARTIFACTS_DIRECTORY, entry)} packs the private @syndroo/core and must never be published; left in place.`,
      );
    }
  }
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  try {
    await pack();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run the CLI when executed directly; importing this module is inert.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
