#!/usr/bin/env node
/**
 * `npm run install:global`: install the seven tarballs `npm run pack:local`
 * wrote into `artifacts/` as global CLI plugins.
 *
 * This is the second half of the local release loop. Packing the tarballs alone
 * is not enough to run the CLI: the packages must be installed together, from
 * local paths, in one command, because the providers depend on the unpublished
 * `@syndroo/provider-sdk`.
 *
 * Two failures this replaces:
 *
 * 1. `npm install --global artifacts/...` (no `./`) is read as a GitHub
 *    shorthand. `installArguments` always prefixes `./`, so npm installs the
 *    local file instead of running `git ls-remote`.
 * 2. Installing one provider tarball alone hits a registry 404 for
 *    `@syndroo/provider-sdk`. The seven tarballs are installed in one command.
 *
 * After a successful install the global tree is read back with
 * `npm ls --global --depth=0` and every one of the seven names must be present.
 *
 * Run with Node's type stripping:
 *
 *   node scripts/install-local.ts
 *   node scripts/install-local.ts --dry-run
 *   node scripts/install-local.ts --help
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARTIFACTS_DIRECTORY,
  globalInstallPackageNames,
  installArguments,
  missingArtifacts,
  sharedVersion,
  type PackageVersion,
} from "./lib/local-release.ts";
import { ROOT, STAGES } from "./lib/v1-stages.ts";

const USAGE = `Usage: npm run install:global [--dry-run]

Installs the seven @syndroo CLI plugin tarballs from ./${ARTIFACTS_DIRECTORY}/ globally.
--dry-run prints the exact npm install command and exits without installing.
`;

/** The ten public stages, in build order. Core is the only one excluded. */
const PUBLIC_STAGES = STAGES.filter((stage) => stage.corePackage !== true);

/** Read the ten public manifests and enforce the single-version rule. */
async function resolveVersion(): Promise<string> {
  const manifests: PackageVersion[] = [];

  for (const stage of PUBLIC_STAGES) {
    const manifest = JSON.parse(
      await readFile(join(ROOT, "packages", stage.dir, "package.json"), "utf8"),
    ) as { version?: string };

    manifests.push({ name: stage.name, version: manifest.version ?? "" });
  }

  return sharedVersion(manifests);
}

/**
 * Read back the global tree and print one line per package. `npm ls` reports an
 * installed name as `<name>@<version>`, so presence is a substring check on
 * that pair; the command's own exit code is ignored because a partial global
 * tree is exactly the failure this verification has to name.
 */
async function verifyInstalled(packages: readonly string[]): Promise<void> {
  const listing = spawnSync("npm", ["ls", "--global", "--depth=0"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const output = `${listing.stdout ?? ""}\n${listing.stderr ?? ""}`;

  const missing: string[] = [];
  for (const name of packages) {
    const present = output.includes(`${name}@`);
    if (!present) {
      missing.push(name);
    }
    console.log(`${present ? "ok     " : "missing"}  ${name}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `npm ls --global --depth=0 does not list ${missing.join(", ")} after install.`,
    );
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`Unknown argument ${JSON.stringify(unknown[0])}.\n${USAGE}`);
    return 1;
  }

  try {
    const version = await resolveVersion();
    const packages = globalInstallPackageNames();
    const artifactsDirectory = join(ROOT, ARTIFACTS_DIRECTORY);
    const missing = missingArtifacts(artifactsDirectory, packages, version);

    if (missing.length > 0) {
      throw new Error(
        `Missing ${missing.length} of ${packages.length} tarballs in ${ARTIFACTS_DIRECTORY}/: ` +
          `${missing.join(", ")}. Run \`npm run pack:local\` first.`,
      );
    }

    const installArgs = installArguments(packages, version);

    if (dryRun) {
      console.log(`npm install --global ${installArgs.join(" ")}`);
      return 0;
    }

    const install = spawnSync("npm", ["install", "--global", ...installArgs], {
      cwd: ROOT,
      stdio: "inherit",
    });

    if (install.status !== 0) {
      throw new Error(
        `npm install --global failed with exit code ${String(install.status ?? "null")}.`,
      );
    }

    await verifyInstalled(packages);
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
