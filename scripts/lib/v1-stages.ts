/**
 * Shared stage list and helpers for the architecture-v1 build and check graphs.
 *
 * `scripts/build-v1.ts` and `scripts/check-v1.ts` both import this module so the
 * two graphs can never disagree about build order or about which packages count
 * as architecture v1. Before this file existed the list was duplicated, which
 * made "build what we check" a convention rather than a fact.
 *
 * The order encodes real dependencies. A consumer that imports an official
 * provider (`@syndroo/sdk`, `@syndroo/cli`) cannot be built before that provider
 * package exists, so the five official providers come after Core and before
 * `sdk`/`server`/`cli`; `cloudflare` is last because it composes every official
 * provider and the Node server. `provider-sdk` is first because Core and every
 * provider implementation depends on its contract.
 *
 * These scripts run through Node's type stripping, so the import specifier keeps
 * the `.ts` extension. `tsconfig.v1-tools.json` type-checks the same files with
 * `allowImportingTsExtensions`, and `tsconfig.scripts.json` enables
 * `rewriteRelativeImportExtensions` so an emitting build rewrites it.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type V1Stage = {
  /** Directory under `packages/`. */
  dir: string;
  /** Workspace package name, exactly as declared in its manifest. */
  name: string;
  /** True for the private package that public artifacts bundle. */
  corePackage?: boolean;
  /** True when the published artifact must bundle private Core. */
  bundlesCore?: boolean;
};

/** Root `engines.node` value required of every architecture-v1 package. */
export const MIN_NODE_ENGINE = ">=24.19.0";

/**
 * Build order for the eleven architecture-v1 packages.
 *
 * `provider-sdk -> core -> five providers -> sdk/server/cli -> cloudflare`.
 * Never reorder a consumer before the official providers it imports.
 */
export const STAGES: readonly V1Stage[] = [
  { dir: "provider-sdk", name: "@syndroo/provider-sdk" },
  { dir: "core", name: "@syndroo/core", corePackage: true },
  { dir: "provider-bluesky", name: "@syndroo/provider-bluesky" },
  { dir: "provider-threads", name: "@syndroo/provider-threads" },
  { dir: "provider-linkedin", name: "@syndroo/provider-linkedin" },
  { dir: "provider-mastodon", name: "@syndroo/provider-mastodon" },
  { dir: "provider-devto", name: "@syndroo/provider-devto" },
  { dir: "sdk", name: "@syndroo/sdk" },
  { dir: "server", name: "@syndroo/server", bundlesCore: true },
  { dir: "cli", name: "@syndroo/cli", bundlesCore: true },
  { dir: "cloudflare", name: "@syndroo/cloudflare", bundlesCore: true },
];

/**
 * The repository root: the nearest ancestor directory that owns both `packages/`
 * and a `package.json`.
 *
 * Resolved by walking up rather than a fixed `../../` climb so this module works
 * both from source (`node scripts/...ts`, the normal case) and from the compiled
 * `.build/scripts/...` tree that `tsconfig.scripts.json` emits - the fixed climb
 * would land on `.build` there. The starting point is the source-correct
 * `scripts/` root, so running from source finds the same directory as before.
 */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "packages")) && existsSync(join(directory, "package.json"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return start;
    }
    directory = parent;
  }
}

/** Repository root, resolved from this file so both scripts agree. */
export const ROOT = repositoryRoot(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** Recursively list `.ts` files under a directory, or `[]` if it is absent. */
export function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTypeScriptFiles(child));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(child);
    }
  }
  return found;
}

/** True when a stage already has sources to build or type-check. */
export function hasSources(stage: V1Stage): boolean {
  return listTypeScriptFiles(join(ROOT, "packages", stage.dir, "src")).length > 0;
}

/** `provider-sdk -> core -> ...`, for one-line run headers. */
export function buildOrderLabel(): string {
  return STAGES.map((stage) => stage.name.replace("@syndroo/", "")).join(" -> ");
}

/** One aligned status line: `3/11  @syndroo/core  ok  npm run build ...`. */
export function formatStageLine(
  index: number,
  stage: V1Stage,
  verdict: string,
  detail: string,
): string {
  const position = `${index + 1}/${STAGES.length}`.padStart(5);
  const name = stage.name.padEnd(30);
  return `${position}  ${name}  ${verdict.padEnd(8)}  ${detail}`;
}
