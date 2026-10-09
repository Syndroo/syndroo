/**
 * Build-time generator for the official provider catalog (C3-6).
 *
 * The CLI's provider trust loader (`packages/cli/src/runtime/providers/**`)
 * accepts a data-only `BuiltinProviderCatalogEntry[]`: for each official
 * provider it needs `provider`, `resolvedRoot`, `artifactFingerprint` and
 * `manifest`. Nothing in the repository produced that data, so an official
 * provider was unreachable unless the operator wrote a `providers` override by
 * hand. This script produces it.
 *
 * Honesty and determinism rules this file follows:
 *
 * 1. **The fingerprint rule is reused, never re-implemented.** The inspector
 *    lives at `packages/cli/src/runtime/providers/inspect.ts`. Node's type
 *    stripping cannot follow that module's `./x.js` specifiers back to `./x.ts`,
 *    and an emitting CLI build cannot be a prerequisite of the catalog (the CLI
 *    imports the generated catalog), so the inspector source is bundled once
 *    with esbuild into a temporary file and imported from there. The rule that
 *    computes `artifactFingerprint` and `resolvedRoot` is therefore literally
 *    the same code the loader runs, not a copy that can drift.
 * 2. **Importing built artifacts is allowed here, and only here.** Official
 *    packages are trusted at build time; the generator imports each built
 *    entrypoint to read its real manifest. Providers are never imported at CLI
 *    runtime, during `status`, or inside a request.
 * 3. **No partial catalog.** Because the manifests come from built artifacts, a
 *    missing or uninspectable package fails the run with the package names
 *    listed. This script never emits a catalog that quietly omits a provider.
 * 4. **Deterministic output.** Provider ids are sorted, every object is
 *    key-sorted, and `resolvedRoot` is stored repository-relative (for example
 *    `packages/provider-bluesky`) so the artifact embeds no absolute path and
 *    survives a moved checkout. The loader call site derives the repository
 *    root from the CLI package root and joins each entry there.
 *
 * Run with Node's type stripping:
 *
 *   node scripts/generate-provider-catalog.ts            # write the catalog
 *   node scripts/generate-provider-catalog.ts --check    # fail on drift
 *
 * `--root <dir>` points at another repository layout (used by tests), and
 * `--out <file>` / `--format ts|json` choose the destination and encoding.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { ROOT, STAGES } from "./lib/v1-stages.ts";

/** Default destination of the committed catalog module. */
export const DEFAULT_CATALOG_FILE = "packages/cli/src/runtime/providers/generated/catalog.ts";

/** One official provider package, taken from the shared stage list. */
export type OfficialProviderStage = {
  /** Provider id: the registry key and the manifest id. */
  readonly id: string;
  /** Directory under `packages/`. */
  readonly dir: string;
  /** Workspace package name. */
  readonly name: string;
};

/**
 * The five official providers, derived from `scripts/lib/v1-stages.ts` so the
 * catalog and the build/check graphs can never disagree about which packages
 * are official. `@syndroo/provider-sdk` is the contract, not a provider.
 */
export function officialProviderStages(): readonly OfficialProviderStage[] {
  return STAGES.flatMap((stage) =>
    stage.dir.startsWith("provider-") && stage.name !== "@syndroo/provider-sdk"
      ? [{ id: stage.dir.slice("provider-".length), dir: stage.dir, name: stage.name }]
      : [],
  );
}

/** One emitted catalog entry: data only, exactly what the loader consumes. */
export type GeneratedCatalogEntry = {
  readonly provider: string;
  /** Installed package name, so a packed CLI can resolve `node_modules` first. */
  readonly packageName: string;
  readonly resolvedRoot: string;
  readonly artifactFingerprint: string;
  readonly manifest: unknown;
};

export type GenerateResult = {
  /** The emitted module or JSON text, byte-stable across runs. */
  readonly text: string;
  /** Sorted provider ids that were emitted. */
  readonly providers: readonly string[];
  readonly entries: readonly GeneratedCatalogEntry[];
};

/** Raised when one or more official packages are not built or not inspectable. */
export class MissingProviderPackagesError extends Error {
  readonly packages: readonly string[];

  constructor(packages: readonly string[]) {
    super(
      "cannot generate the official provider catalog; build these packages first:\n" +
        packages.map((name) => `  - ${name}`).join("\n"),
    );
    this.name = "MissingProviderPackagesError";
    this.packages = packages;
  }
}

/** Sort object keys recursively so two runs produce identical bytes. */
function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      result[key] = sortedValue(source[key]);
    }

    return result;
  }

  return value;
}

type Inspector = {
  inspectSelected(
    provider: string,
    selection: unknown,
  ): Promise<{
    candidate: {
      resolvedRoot: string;
      entrypoint: string;
      artifactFingerprint: string;
      packageName: string;
      version: string;
    };
  }>;
  digestJson(value: unknown): string;
};

/**
 * Bundle the CLI inspector and return its exports.
 *
 * The temporary bundle is removed before this function returns, so it is never
 * a build artifact anyone depends on.
 */
async function loadInspector(entry: string): Promise<Inspector> {
  const directory = await mkdtemp(path.join(tmpdir(), "syndroo-provider-catalog-"));
  const bundle = path.join(directory, "inspect.mjs");

  try {
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });

    return (await import(pathToFileURL(bundle).href)) as Inspector;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Read the manifest a built provider artifact exports. */
async function readManifest(entrypoint: string): Promise<unknown> {
  const namespace = (await import(
    /* @vite-ignore */ pathToFileURL(entrypoint).href
  )) as { default?: { manifest?: unknown } };
  const manifest = namespace.default?.manifest;

  if (manifest === undefined) {
    throw new Error(
      `the built artifact at ${entrypoint} does not export a default provider with a manifest`,
    );
  }

  return manifest;
}

export type GenerateOptions = {
  /** Repository root to enumerate. Defaults to the real repository root. */
  readonly root?: string;
  /** Directory the emitted `resolvedRoot` values are relative to. Defaults to the repository root. */
  readonly base?: string;
  /** `ts` emits the committed module, `json` emits the bare entry array. */
  readonly format?: "ts" | "json";
};

/**
 * Enumerate the official packages and produce the catalog text.
 *
 * Throws `MissingProviderPackagesError` when any official package cannot be
 * inspected, so a partial catalog is never produced.
 */
export async function generateProviderCatalog(options: GenerateOptions = {}): Promise<GenerateResult> {
  const root = path.resolve(options.root ?? ROOT);
  const base = path.resolve(options.base ?? root);
  const format = options.format ?? "ts";
  const stages = officialProviderStages();
  // The fingerprint rule always comes from this repository, never from the
  // enumerated root: `--root` changes which packages are catalogued, not which
  // trust rule applies.
  const inspector = await loadInspector(
    path.join(ROOT, "packages", "cli", "src", "runtime", "providers", "inspect.ts"),
  );

  const missing: string[] = [];
  const entries: GeneratedCatalogEntry[] = [];

  for (const stage of stages) {
    const packageRoot = path.join(root, "packages", stage.dir);

    try {
      // The shared inspector enforces the entrypoint rule and computes the
      // exact artifact fingerprint the trust loader recomputes at load.
      const selection = {
        roots: new Map([[stage.id, { root: packageRoot }]]),
        configFingerprint: inspector.digestJson([]),
        configDirectory: path.join(root, "packages", "cli"),
      };
      const inspection = await inspector.inspectSelected(stage.id, selection);
      const candidate = inspection.candidate;
      const manifest = await readManifest(path.join(candidate.resolvedRoot, candidate.entrypoint));
      const recordedId = (manifest as { id?: unknown }).id;

      if (recordedId !== stage.id) {
        throw new Error(
          `manifest id ${JSON.stringify(recordedId)} does not match provider id ${JSON.stringify(stage.id)}`,
        );
      }

      const relativeRoot = path.relative(base, candidate.resolvedRoot).split(path.sep).join("/");

      if (relativeRoot.length === 0 || relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) {
        throw new Error(`resolved root ${candidate.resolvedRoot} is not inside ${base}`);
      }

      entries.push({
        provider: stage.id,
        packageName: candidate.packageName,
        resolvedRoot: relativeRoot,
        artifactFingerprint: candidate.artifactFingerprint,
        manifest: sortedValue(manifest),
      });
    } catch (error) {
      missing.push(
        `${stage.name} (packages/${stage.dir}: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (missing.length > 0) {
    throw new MissingProviderPackagesError(missing);
  }

  entries.sort((left, right) =>
    left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0,
  );

  return {
    text: format === "json" ? `${JSON.stringify(entries, null, 2)}\n` : renderModule(entries),
    providers: entries.map((entry) => entry.provider),
    entries,
  };
}

/** Render the committed TypeScript module, header first. */
function renderModule(entries: readonly GeneratedCatalogEntry[]): string {
  return [
    "/**",
    " * GENERATED FILE - DO NOT EDIT BY HAND.",
    " *",
    " * Produced by `npm run generate:provider-catalog`",
    " * (scripts/generate-provider-catalog.ts), which:",
    " *   1. enumerates the official providers from scripts/lib/v1-stages.ts;",
    " *   2. inspects each built package with the exact artifact-fingerprint rule",
    " *      the trust loader uses (runtime/providers/inspect.ts, bundled and",
    " *      reused, never re-implemented);",
    " *   3. imports each built artifact at build time to read its real manifest;",
    " *   4. writes this sorted, data-only catalog.",
    " *",
    " * `resolvedRoot` is repository-relative on purpose (for example",
    " * `packages/provider-bluesky`), so the artifact embeds no absolute path and",
    " * survives a moved checkout. runtime/local/composition.ts derives the",
    " * repository root from the CLI package root and resolves each entry there.",
    " *",
    " * Verify with `npm run check:provider-catalog` after building the five",
    " * provider packages. This is build-time data: provider packages are never",
    " * imported at CLI runtime or during a request.",
    " */",
    'import type { BuiltinProviderCatalogEntry } from "../types.js";',
    "",
    "export const BUILTIN_PROVIDER_CATALOG: readonly BuiltinProviderCatalogEntry[] = " +
      `${JSON.stringify(entries, null, 2)};`,
    "",
  ].join("\n");
}

type CliOptions = {
  readonly out: string;
  readonly root?: string;
  readonly format: "ts" | "json";
  readonly check: boolean;
};

const USAGE = [
  "usage: node scripts/generate-provider-catalog.ts [--check] [--out <file>] [--root <dir>] [--format ts|json]",
  "",
  "  --check           compare the committed catalog with a fresh generation",
  `  --out <file>      destination (default: ${DEFAULT_CATALOG_FILE})`,
  "  --root <dir>      repository root to enumerate (default: this repository)",
  "  --format ts|json  emitted encoding (default: ts)",
].join("\n");

function parseArguments(argv: readonly string[]): CliOptions {
  let out = DEFAULT_CATALOG_FILE;
  let root: string | undefined;
  let format: "ts" | "json" = "ts";
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === "--check") {
      check = true;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (flag === "--out" || flag === "--root") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error(`${flag} needs a value\n\n${USAGE}`);
      }

      index += 1;

      if (flag === "--out") {
        out = value;
      } else {
        root = path.resolve(value);
      }
    } else if (flag === "--format") {
      const value = argv[index + 1];

      if (value !== "ts" && value !== "json") {
        throw new Error(`--format must be ts or json\n\n${USAGE}`);
      }

      format = value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${String(flag)}\n\n${USAGE}`);
    }
  }

  return { out, ...(root === undefined ? {} : { root }), format, check };
}

async function main(): Promise<number> {
  let options: CliOptions;

  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const destination = path.resolve(options.out);

  try {
    const generated = await generateProviderCatalog({
      ...(options.root === undefined ? {} : { root: options.root }),
      format: options.format,
    });

    if (options.check) {
      const committed = await readFile(destination, "utf8").catch(() => undefined);

      if (committed === undefined) {
        console.error(`no catalog at ${destination}; run \`npm run generate:provider-catalog\``);
        return 1;
      }

      if (committed === generated.text) {
        console.log(`provider catalog is up to date: ${generated.providers.join(", ")}`);
        return 0;
      }

      console.error(
        "provider catalog drift: the committed catalog does not match the built packages.\n" +
          "run `npm run generate:provider-catalog` and review the change " +
          `(${generated.providers.join(", ")})`,
      );
      return 1;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, generated.text);
    const relativeDestination = path.relative(ROOT, destination);
    console.log(
      `wrote ${
        relativeDestination.startsWith("..") ? destination : relativeDestination
      } with ${generated.providers.length} providers: ${generated.providers.join(", ")}`,
    );
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

