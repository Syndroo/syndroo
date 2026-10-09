/**
 * F4: build the published `@syndroo/cloudflare` Worker artifact.
 *
 * The Worker bundle composes the private `@syndroo/core` (plus `@syndroo/server`
 * and the five official providers), so the shipped `dist/worker.js` must be a
 * single self-contained ESM file: no external import, no `node:` import, and no
 * runtime dependency on an unpublished package. This is the same requirement as
 * the CLI and server bundles, so it reuses `scripts/lib/bundle-v1.ts`; the only
 * Worker-specific additions are the two rejection rules below.
 *
 * The Worker's `build` script runs `src/build/generate.ts` first (it writes the
 * standalone validators and the embedded catalog), then calls this script, which
 * owns the declaration build and the bundle exactly like the CLI and server
 * steps: `tsc -p tsconfig.build.json` for the public declarations, then esbuild.
 *
 * Run with Node's type stripping, from `packages/cloudflare` via the manifest
 * `build` script:
 *
 *   node ../../scripts/bundle-v1-cloudflare.ts
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

/** Package directory of the Worker. */
export const CLOUDFLARE_PACKAGE_DIR = path.join(ROOT, "packages", "cloudflare");
/** Directory the published tarball ships (`files` in the manifest). */
export const CLOUDFLARE_DIST_DIR = path.join(CLOUDFLARE_PACKAGE_DIR, "dist");
/** Record of what the last bundle inlined and left external. */
export const CLOUDFLARE_BUNDLE_INFO = "bundle.json";
/** Format marker for `dist/bundle.json`. */
export const CLOUDFLARE_BUNDLE_FORMAT = "syndroo-cloudflare-bundle-v1";

/** The single published entry point, mirroring `main`/`exports`. */
export const CLOUDFLARE_BUNDLE_ENTRIES = [
  { source: "src/index.ts", output: "worker.js" },
] as const satisfies readonly BundleEntry[];

/**
 * Workspace packages the Worker composes and must therefore inline. Anything
 * `@syndroo/*` that survives as an import in `worker.js` is a bug: there is no
 * `node_modules` inside a Workers deployment to resolve it from.
 */
export const CLOUDFLARE_INLINED_PACKAGES = [
  "@syndroo/core",
  "@syndroo/server",
  "@syndroo/server/http",
  "@syndroo/provider-sdk",
  "@syndroo/provider-bluesky",
  "@syndroo/provider-devto",
  "@syndroo/provider-linkedin",
  "@syndroo/provider-mastodon",
  "@syndroo/provider-threads",
] as const;

/** The single spec the Worker build and the Worker gate both read. */
export const CLOUDFLARE_BUNDLE_SPEC: BundleSpec = {
  name: "@syndroo/cloudflare",
  label: "Worker",
  packageDir: CLOUDFLARE_PACKAGE_DIR,
  distDir: CLOUDFLARE_DIST_DIR,
  infoFile: CLOUDFLARE_BUNDLE_INFO,
  format: CLOUDFLARE_BUNDLE_FORMAT,
  generator: "scripts/bundle-v1-cloudflare.ts",
  entries: CLOUDFLARE_BUNDLE_ENTRIES,
  external: [],
  requiredInlined: ["@syndroo/core"],
  forbiddenImports: CLOUDFLARE_INLINED_PACKAGES,
  platform: "browser",
  target: "es2024",
  aliasNodeBuiltins: false,
  declarationsTsconfig: "tsconfig.build.json",
  allowedExtensions: [".js", ".json", ".d.ts"],
  rejectNodeImports: true,
  rejectExternalImports: true,
  coreLabel: "Core",
};

/** Build the artifact. Returns the written bundle record. */
export function bundleCloudflare(): Promise<BundleRecord> {
  return bundlePackage(CLOUDFLARE_BUNDLE_SPEC);
}

/** Verify a built artifact from disk alone, without rebuilding it. */
export function verifyCloudflareBundleArtifact(distDirectory = CLOUDFLARE_DIST_DIR): string[] {
  return verifyBundleArtifact(CLOUDFLARE_BUNDLE_SPEC, distDirectory);
}

/** Verify the bundle step: the manifest must wire the bundler and own Core. */
export function verifyCloudflareBundleStep(): string[] {
  return verifyBundleStep(CLOUDFLARE_BUNDLE_SPEC);
}

/** Built-artifact status; `built` is false when this tree has no bundle yet. */
export function cloudflareBundleStatus(distDirectory = CLOUDFLARE_DIST_DIR): {
  readonly built: boolean;
  readonly problems: readonly string[];
} {
  return bundleStatus(CLOUDFLARE_BUNDLE_SPEC, distDirectory);
}

async function main(): Promise<number> {
  try {
    const record = await bundleCloudflare();
    console.log(`Worker bundle written to ${path.relative(ROOT, CLOUDFLARE_DIST_DIR)}`);
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
