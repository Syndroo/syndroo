/**
 * F3a: build the published `@syndroo/cli` artifact.
 *
 * `@syndroo/cli` is one of three architecture-v1 packages that ship a private
 * workspace dependency: `@syndroo/core` is private and unpublishable, and the
 * CLI's runtime genuinely uses it. A plain `tsc` build therefore produced a
 * `dist/` that could not run outside this repository, which is exactly what the
 * check graph reported as `[bundle] PENDING`.
 *
 * This script replaces that build. It emits
 *
 *   1. the public declarations (`tsc -p tsconfig.build.json`,
 *      `emitDeclarationOnly`), so `@syndroo/cli` and `@syndroo/cli/runtime`
 *      still type-check for embedders, and
 *   2. the published JavaScript as three self-contained ESM bundles
 *      (`dist/bin.js`, `dist/index.js`, `dist/runtime/index.js`) that inline
 *      every private workspace package.
 *
 * Public packages (`commander`, `ajv`, `ajv-formats`) stay external and remain
 * runtime dependencies; bundling them would ship someone else's code without
 * their update path. Everything else - including the public but tiny
 * `@syndroo/provider-sdk`, which the provider-schema checks need at runtime -
 * is compiled in, so the tarball depends on nothing unpublished.
 *
 * The mechanics (declaration build, esbuild, the `dist/bundle.json` record and
 * the from-disk verification) live in `scripts/lib/bundle-v1.ts`, shared with
 * `@syndroo/server` and `@syndroo/cloudflare` so the three cannot drift apart.
 *
 * Run with Node's type stripping:
 *
 *   node scripts/bundle-v1-cli.ts
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  bundlePackage,
  bundleStatus,
  verifyBundleArtifact,
  verifyBundleStep,
  type BundleEntry,
  type BundleRecord,
  type BundleSpec,
} from "./lib/bundle-v1.ts";
import { ROOT } from "./lib/v1-stages.ts";

/** Package directory of the CLI. */
export const CLI_PACKAGE_DIR = path.join(ROOT, "packages", "cli");
/** Directory the published tarball ships (`files` in the manifest). */
export const CLI_DIST_DIR = path.join(CLI_PACKAGE_DIR, "dist");
/** Record of what the last bundle inlined and left external. */
export const CLI_BUNDLE_INFO = "bundle.json";
/** Format marker for `dist/bundle.json`. */
export const CLI_BUNDLE_FORMAT = "syndroo-cli-bundle-v1";

/**
 * Published entry points, mirroring `bin` and `exports` in the manifest.
 * `runtime/index.ts` is the subpath `@syndroo/server` composes.
 */
export const CLI_BUNDLE_ENTRIES = [
  { source: "src/bin.ts", output: "bin.js" },
  { source: "src/index.ts", output: "index.js" },
  { source: "src/runtime/index.ts", output: "runtime/index.js" },
] as const satisfies readonly BundleEntry[];

/**
 * Public packages that stay external. Each must also be a runtime dependency of
 * the manifest, which `scripts/check-v1.ts` verifies.
 */
export const CLI_EXTERNAL_DEPENDENCIES = ["ajv", "ajv-formats", "commander"] as const;

export type CliBundleRecord = BundleRecord;

/** The single spec the CLI build and the CLI gate both read. */
export const CLI_BUNDLE_SPEC: BundleSpec = {
  name: "@syndroo/cli",
  label: "CLI",
  packageDir: CLI_PACKAGE_DIR,
  distDir: CLI_DIST_DIR,
  infoFile: CLI_BUNDLE_INFO,
  format: CLI_BUNDLE_FORMAT,
  generator: "scripts/bundle-v1-cli.ts",
  entries: CLI_BUNDLE_ENTRIES,
  external: CLI_EXTERNAL_DEPENDENCIES,
  requiredInlined: ["@syndroo/core"],
  forbiddenImports: ["@syndroo/core", "@syndroo/provider-sdk", "@syndroo/sdk"],
  platform: "node",
  target: "node24",
  aliasNodeBuiltins: true,
  declarationsTsconfig: "tsconfig.build.json",
  chmod: ["bin.js"],
  shebang: "bin.js",
  allowedExtensions: [".js", ".json", ".d.ts"],
  coreLabel: "Core",
};

/** Build the artifact. Returns the written bundle record. */
export function bundleCli(): Promise<BundleRecord> {
  return bundlePackage(CLI_BUNDLE_SPEC);
}

/**
 * Verify a built artifact from disk alone.
 *
 * The gate calls this without building: it answers "does the published bundle
 * exist, is the private Core compiled in rather than required, and does the
 * artifact leak a build path".
 */
export function verifyCliBundleArtifact(distDirectory = CLI_DIST_DIR): string[] {
  return verifyBundleArtifact(CLI_BUNDLE_SPEC, distDirectory);
}

/**
 * Verify the bundle *step* without building anything: the manifest must run the
 * bundler, must keep private Core out of `dependencies`, and must keep Core as a
 * devDependency so the bundled source stays owned by the build.
 */
export function verifyCliBundleStep(): string[] {
  return verifyBundleStep(CLI_BUNDLE_SPEC);
}

/**
 * The built-artifact status: `built` is false when this tree has no bundle yet,
 * which is "not built here" rather than a failure. Once the artifact exists its
 * problems are returned.
 */
export function cliBundleStatus(distDirectory = CLI_DIST_DIR): {
  readonly built: boolean;
  readonly problems: readonly string[];
} {
  return bundleStatus(CLI_BUNDLE_SPEC, distDirectory);
}

async function main(): Promise<number> {
  try {
    const record = await bundleCli();
    console.log(`CLI bundle written to ${path.relative(ROOT, CLI_DIST_DIR)}`);
    console.log(`  entrypoints: ${record.entrypoints.join(", ")}`);
    console.log(`  external: ${record.external.join(", ")}`);
    console.log(`  inlined workspace packages: ${record.inlinedWorkspacePackages.join(", ")}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run the CLI when executed directly; importing this module is inert.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
