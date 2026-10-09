/**
 * F4: build the published `@syndroo/server` artifact.
 *
 * `@syndroo/server` uses the private `@syndroo/core` at runtime, so a plain
 * `tsc` build produced a `dist/` that could not run outside this repository -
 * exactly what the check graph reported as `[bundle] PENDING`. This script
 * replaces that build. It emits
 *
 *   1. the public declarations (`tsc -p tsconfig.build.json`,
 *      `emitDeclarationOnly`), so `@syndroo/server` and `@syndroo/server/http`
 *      still type-check for embedders, and
 *   2. the published JavaScript as two self-contained ESM bundles
 *      (`dist/index.js`, `dist/http/index.js`) that inline Core.
 *
 * The server composes the Node host pieces from `@syndroo/cli/runtime` (a
 * public package, declared as a runtime dependency), so that one specifier stays
 * external. Everything private - Core above all - is compiled in, so the tarball
 * never depends on an unpublished package. The mechanics live in
 * `scripts/lib/bundle-v1.ts`, shared with the CLI and Worker bundles.
 *
 * Run with Node's type stripping:
 *
 *   node scripts/bundle-v1-server.ts
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

/** Package directory of the server. */
export const SERVER_PACKAGE_DIR = path.join(ROOT, "packages", "server");
/** Directory the published tarball ships (`files` in the manifest). */
export const SERVER_DIST_DIR = path.join(SERVER_PACKAGE_DIR, "dist");
/** Record of what the last bundle inlined and left external. */
export const SERVER_BUNDLE_INFO = "bundle.json";
/** Format marker for `dist/bundle.json`. */
export const SERVER_BUNDLE_FORMAT = "syndroo-server-bundle-v1";

/** Published entry points, mirroring `exports` in the manifest. */
export const SERVER_BUNDLE_ENTRIES = [
  { source: "src/index.ts", output: "index.js" },
  { source: "src/http/index.ts", output: "http/index.js" },
] as const satisfies readonly BundleEntry[];

/** The single spec the server build and the server gate both read. */
export const SERVER_BUNDLE_SPEC: BundleSpec = {
  name: "@syndroo/server",
  label: "server",
  packageDir: SERVER_PACKAGE_DIR,
  distDir: SERVER_DIST_DIR,
  infoFile: SERVER_BUNDLE_INFO,
  format: SERVER_BUNDLE_FORMAT,
  generator: "scripts/bundle-v1-server.ts",
  entries: SERVER_BUNDLE_ENTRIES,
  external: ["@syndroo/cli"],
  requiredInlined: ["@syndroo/core"],
  forbiddenImports: ["@syndroo/core", "@syndroo/provider-sdk"],
  platform: "node",
  target: "node24",
  aliasNodeBuiltins: true,
  declarationsTsconfig: "tsconfig.build.json",
  allowedExtensions: [".js", ".json", ".d.ts"],
  coreLabel: "Core",
};

/** Build the artifact. Returns the written bundle record. */
export function bundleServer(): Promise<BundleRecord> {
  return bundlePackage(SERVER_BUNDLE_SPEC);
}

/** Verify a built artifact from disk alone, without rebuilding it. */
export function verifyServerBundleArtifact(distDirectory = SERVER_DIST_DIR): string[] {
  return verifyBundleArtifact(SERVER_BUNDLE_SPEC, distDirectory);
}

/** Verify the bundle step: the manifest must wire the bundler and own Core. */
export function verifyServerBundleStep(): string[] {
  return verifyBundleStep(SERVER_BUNDLE_SPEC);
}

/** Built-artifact status; `built` is false when this tree has no bundle yet. */
export function serverBundleStatus(distDirectory = SERVER_DIST_DIR): {
  readonly built: boolean;
  readonly problems: readonly string[];
} {
  return bundleStatus(SERVER_BUNDLE_SPEC, distDirectory);
}

async function main(): Promise<number> {
  try {
    const record = await bundleServer();
    console.log(`server bundle written to ${path.relative(ROOT, SERVER_DIST_DIR)}`);
    console.log(`  entrypoints: ${record.entrypoints.join(", ")}`);
    console.log(`  external: ${record.external.length === 0 ? "(none)" : record.external.join(", ")}`);
    console.log(`  inlined workspace packages: ${record.inlinedWorkspacePackages.join(", ")}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run the bundler when executed directly; importing this module is inert.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
