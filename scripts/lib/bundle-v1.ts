/**
 * Shared bundling and verification for the architecture-v1 artifacts that must
 * inline the private `@syndroo/core`.
 *
 * Three published packages ship a self-contained bundle: `@syndroo/cli` (the
 * Node CLI), `@syndroo/server` (the Node HTTP server) and
 * `@syndroo/cloudflare` (the Workers bundle). They differ only in entry points,
 * platform and whether any public dependency stays external, so the mechanics
 * live here once: run the declaration build, run esbuild, write a small
 * `bundle.json` record of what was inlined and left external, and verify the
 * emitted files from disk alone.
 *
 * One `verifyBundleArtifact` backs both the build (the `bundle-*` scripts throw
 * when it reports a problem) and the gate (`scripts/check-v1.ts` reads an
 * already-built artifact and prints the same problems), so an artifact cannot
 * pass one and fail the other. The gate never trusts the record on its own: it
 * also reads the emitted JavaScript and refuses any surviving import of an
 * inlined workspace package, any absolute build path, and - for the Worker - any
 * external or `node:` import.
 *
 * Run with Node's type stripping; the import specifier keeps the `.ts`
 * extension so both graphs agree.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { ROOT } from "./v1-stages.ts";

/** Bare built-in names mapped to their explicit `node:` form. */
export const NODE_BUILTIN_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  builtinModules.filter((name) => !name.startsWith("node:")).map((name) => [name, `node:${name}`]),
);

/** One published entry point, mirroring `bin`/`exports`. */
export type BundleEntry = { readonly source: string; readonly output: string };

/** The facts the bundler had in hand, recorded next to the artifact. */
export type BundleRecord = {
  readonly format: string;
  readonly generator: string;
  readonly entrypoints: readonly string[];
  readonly external: readonly string[];
  readonly inlinedWorkspacePackages: readonly string[];
};

/**
 * Everything that differs between the bundled packages. The build and the gate
 * both read a single spec, so they can never disagree about what "verified"
 * means.
 */
export type BundleSpec = {
  /** Workspace package name, e.g. `@syndroo/cli`. */
  readonly name: string;
  /** Human label used in build diagnostics, e.g. `CLI`. */
  readonly label: string;
  /** Package directory (absolute). */
  readonly packageDir: string;
  /** Directory the tarball ships (`files` in the manifest). */
  readonly distDir: string;
  /** Record file written inside `distDir`. */
  readonly infoFile: string;
  /** Format marker recorded in `infoFile`. */
  readonly format: string;
  /** Value recorded as the record `generator`, and looked for in `scripts.build`. */
  readonly generator: string;
  /** Published entry points, in `bin`/`exports` order. */
  readonly entries: readonly BundleEntry[];
  /** Public packages that stay external and must be runtime dependencies. */
  readonly external: readonly string[];
  /** Workspace packages that must be compiled in rather than imported. */
  readonly requiredInlined: readonly string[];
  /** Specifiers that must not survive as an import in the emitted JavaScript. */
  readonly forbiddenImports: readonly string[];
  /** esbuild platform and target. */
  readonly platform: "node" | "browser";
  readonly target: string;
  /** True to alias bare Node built-ins to their `node:` form. */
  readonly aliasNodeBuiltins: boolean;
  /** Declarations tsconfig relative to `packageDir`; omitted to skip the step. */
  readonly declarationsTsconfig?: string;
  /** Output files that must stay executable. */
  readonly chmod?: readonly string[];
  /** Output file that must keep a `#!` shebang. */
  readonly shebang?: string;
  /** Extensions allowed in the artifact directory. */
  readonly allowedExtensions: readonly string[];
  /** Worker rule: the bundle must contain no `node:` import. */
  readonly rejectNodeImports?: boolean;
  /** Worker rule: the bundle must contain no external (bare) import. */
  readonly rejectExternalImports?: boolean;
  /**
   * Word used in the "not a devDependency" diagnostic. Defaults to the inlined
   * package name so the message stays specific.
   */
  readonly coreLabel?: string;
};

type EsbuildMetafile = {
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly outputs?: Readonly<Record<string, { readonly imports?: readonly unknown[] }>>;
};

/** Repository-relative POSIX path, for stable diagnostics. */
export function packageRelative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

/** Workspace package name owning an absolute source path, or `undefined`. */
export function workspacePackageOf(absolute: string): string | undefined {
  const relative = path.relative(ROOT, absolute);
  const parts = relative.split(path.sep);

  if (parts[0] !== "packages" || parts.length < 3) {
    return undefined;
  }

  const manifest = path.join(ROOT, "packages", parts[1] as string, "package.json");

  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn bundle metadata into the record the gate and the tarball reviewer both
 * read: which workspace packages were compiled in, which specifiers left the
 * bundle bare.
 */
export function bundleRecord(spec: BundleSpec, metafile: EsbuildMetafile): BundleRecord {
  const inlined = new Set<string>();

  for (const input of Object.keys(metafile.inputs ?? {})) {
    if (input.includes("node_modules")) {
      continue;
    }

    const name = workspacePackageOf(path.resolve(spec.packageDir, input));

    if (name !== undefined && name !== spec.name) {
      inlined.add(name);
    }
  }

  return {
    format: spec.format,
    generator: spec.generator,
    entrypoints: spec.entries.map((entry) => entry.output),
    external: [...spec.external],
    inlinedWorkspacePackages: [...inlined].sort(),
  };
}

/** Every file below a directory, relative and sorted. */
export function listRelative(directory: string): string[] {
  const found: string[] = [];

  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const stat = statSync(absolute);

    if (stat.isDirectory()) {
      for (const child of listRelative(absolute)) {
        found.push(`${name}/${child}`);
      }
    } else {
      found.push(name);
    }
  }

  return found.sort();
}

/** Directory inside `distDir` that holds declarations copied from bundled packages. */
export const VENDORED_DECLARATIONS_DIRECTORY = "_vendor";

/** `@syndroo/provider-sdk` -> `provider-sdk`, the directory under `packages/`. */
function workspaceSlug(packageName: string): string {
  return packageName.replace(/^@[^/]+\//u, "");
}

/**
 * The workspace package a bare specifier names, or `undefined` when the
 * specifier does not point at a package under `packages/`.
 *
 * Only real workspace packages matter: `ajv` and `commander` are ordinary
 * published dependencies and are resolved from `node_modules` by the embedder.
 */
export function workspacePackageName(specifier: string): string | undefined {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

  if (name === undefined || name === "") {
    return undefined;
  }

  try {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "packages", workspaceSlug(name), "package.json"), "utf8"),
    ) as { name?: unknown };

    return manifest.name === name ? name : undefined;
  } catch {
    return undefined;
  }
}

type VendoredPackage = {
  readonly name: string;
  /** Absolute directory the copied declarations live in. */
  readonly targetDirectory: string;
};

/**
 * The module specifier a `.d.ts` would use to reach `targetFile`, in the emitted
 * NodeNext style (`./x.js`). Declaration files resolve `.js` back to `.d.ts`.
 */
function relativeModuleSpecifier(fromDirectory: string, targetFile: string): string {
  let relative = path.relative(fromDirectory, targetFile).split(path.sep).join("/");

  relative = relative.replace(/\.d\.ts$/u, "").replace(/\.ts$/u, "");

  return relative.startsWith(".") ? `${relative}.js` : `./${relative}.js`;
}

/** Import/export specifier occurrences, so only real imports are rewritten. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(@syndroo\/[^"']+)\1/gu;

/**
 * Resolve one workspace specifier (`@syndroo/core` or `@syndroo/server/http`) to
 * the copied declaration it should point at, or `undefined` when it is not a
 * vendored package.
 */
function vendoredTarget(specifier: string, packages: readonly VendoredPackage[]): string | undefined {
  for (const pkg of packages) {
    if (specifier === pkg.name) {
      const entry = path.join(pkg.targetDirectory, "index.d.ts");
      return existsSync(entry) ? entry : undefined;
    }

    if (specifier.startsWith(`${pkg.name}/`)) {
      const subpath = specifier.slice(pkg.name.length + 1);

      for (const candidate of [`${subpath}.d.ts`, `${subpath}/index.d.ts`]) {
        const target = path.join(pkg.targetDirectory, candidate);

        if (existsSync(target)) {
          return target;
        }
      }
    }
  }

  return undefined;
}

/** Copy one workspace package's declarations into `dist/_vendor/<slug>`. */
async function copyDeclarations(packageName: string, vendoredRoot: string): Promise<VendoredPackage> {
  const sourceDirectory = path.join(ROOT, "packages", workspaceSlug(packageName), "dist");
  const targetDirectory = path.join(vendoredRoot, workspaceSlug(packageName));

  if (!existsSync(path.join(sourceDirectory, "index.d.ts"))) {
    throw new Error(
      `cannot inline ${packageName} declarations: ${packageRelative(sourceDirectory)}/index.d.ts is missing; build the workspace first`,
    );
  }

  for (const relative of listRelative(sourceDirectory)) {
    if (!relative.endsWith(".d.ts")) {
      continue;
    }

    const text = await readFile(path.join(sourceDirectory, relative), "utf8");
    const target = path.join(targetDirectory, relative);

    await mkdir(path.dirname(target), { recursive: true });
    // The sources are not published, so a dangling source map is worse than none.
    await writeFile(target, text.replace(/\/\/# sourceMappingURL=[^\n]*\n?/gu, ""), "utf8");
  }

  return { name: packageName, targetDirectory };
}

/**
 * Inline the declarations of every workspace package that was compiled into the
 * JavaScript bundle.
 *
 * The published `.d.ts` must be self-contained: an embedder type-checks the
 * tarball without the private workspace, so a surviving `@syndroo/core` import
 * would make the package unusable. Each bundled package's declaration tree is
 * copied under `dist/_vendor/<slug>/` and every reference to it is rewritten to
 * a relative specifier.
 *
 * Vendoring a dependency's whole `dist/` also copies surfaces the published
 * entry points never expose - for the Worker that is `@syndroo/server`'s
 * Node-only `compose/` entry, whose declarations name `@syndroo/cli/runtime`, a
 * package the Worker does not depend on. Shipping it would break an embedder, so
 * the copy is pruned to the transitive closure of the emitted declarations
 * before verification runs.
 */
export async function inlineWorkspaceDeclarations(
  distDirectory: string,
  packageNames: readonly string[],
): Promise<void> {
  const vendoredRoot = path.join(distDirectory, VENDORED_DECLARATIONS_DIRECTORY);
  await rm(vendoredRoot, { recursive: true, force: true });

  if (packageNames.length === 0) {
    return;
  }

  const packages: VendoredPackage[] = [];

  for (const name of [...packageNames].sort()) {
    packages.push(await copyDeclarations(name, vendoredRoot));
  }

  for (const relative of listRelative(distDirectory)) {
    if (!relative.endsWith(".d.ts")) {
      continue;
    }

    const file = path.join(distDirectory, relative);
    const text = await readFile(file, "utf8");
    const rewritten = text.replace(IMPORT_SPECIFIER, (match, quote: string, specifier: string) => {
      const target = vendoredTarget(specifier, packages);

      return target === undefined
        ? match
        : match.replace(`${quote}${specifier}${quote}`, `${quote}${relativeModuleSpecifier(path.dirname(file), target)}${quote}`);
    });

    if (rewritten !== text) {
      await writeFile(file, rewritten, "utf8");
    }
  }

  pruneUnreachableDeclarations(distDirectory);
}

/** `@syndroo/core` or `@syndroo/server/http` -> the declaration it resolves to. */
function resolveRelativeDeclaration(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.(?:m?js)$/u, ""));

  for (const candidate of [`${base}.d.ts`, path.join(base, "index.d.ts")]) {
    if (candidate.endsWith(".d.ts") && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return undefined;
}

/** `/// <reference path="./x.d.ts" />`, the one non-import way a `.d.ts` reaches another. */
const REFERENCE_PATH = /<reference\s+path\s*=\s*(["'])([^"']+)\1/gu;

/**
 * Delete vendored declarations that nothing in the published artifact can
 * reach, then remove the directories they left behind.
 *
 * Reachability starts at the package's own emitted `.d.ts` (everything outside
 * `_vendor`) and follows relative specifiers, so what ships is exactly the
 * declaration closure of the published entry points. A `_vendor` file that a
 * published declaration does import is kept, and `verifyBundleArtifact` still
 * refuses the artifact when such a file names a package the manifest does not
 * declare.
 */
export function pruneUnreachableDeclarations(distDirectory: string): string[] {
  const vendoredRoot = path.join(distDirectory, VENDORED_DECLARATIONS_DIRECTORY);

  if (!existsSync(vendoredRoot)) {
    return [];
  }

  const declarations = listRelative(distDirectory).filter((relative) => relative.endsWith(".d.ts"));
  const known = new Set(declarations);
  const reached = new Set<string>();
  const queue = declarations.filter((relative) => !isVendored(relative));

  while (queue.length > 0) {
    const relative = queue.pop() as string;

    if (reached.has(relative)) {
      continue;
    }

    reached.add(relative);

    const file = path.join(distDirectory, relative);
    const text = readFileSync(file, "utf8");
    const specifiers = collectImportSpecifiers(text);

    for (const match of text.matchAll(REFERENCE_PATH)) {
      if (match[2] !== undefined) {
        specifiers.push(match[2]);
      }
    }

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        continue;
      }

      const target = resolveRelativeDeclaration(file, specifier);

      if (target === undefined) {
        continue;
      }

      const resolved = path.relative(distDirectory, target).split(path.sep).join("/");

      if (known.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  const removed: string[] = [];

  for (const relative of declarations) {
    if (!isVendored(relative) || reached.has(relative)) {
      continue;
    }

    rmSync(path.join(distDirectory, relative));
    removed.push(relative);
  }

  removeEmptyDirectories(vendoredRoot);

  return removed.sort();
}

/** Vendored declaration files live under `_vendor/`; the package's own do not. */
function isVendored(relative: string): boolean {
  return relative === VENDORED_DECLARATIONS_DIRECTORY || relative.startsWith(`${VENDORED_DECLARATIONS_DIRECTORY}/`);
}

/** Depth-first removal of the directories a prune emptied, innermost first. */
function removeEmptyDirectories(directory: string): void {
  for (const name of readdirSync(directory)) {
    const child = path.join(directory, name);

    if (statSync(child).isDirectory()) {
      removeEmptyDirectories(child);
    }
  }

  try {
    rmdirSync(directory);
  } catch {
    // Not empty: it still contains a declaration the artifact needs.
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Every module specifier the file actually imports, static or dynamic.
 *
 * Only import statements are matched, never bare string literals: an Ajv
 * standalone validator legitimately embeds the text `require("ajv/...")` inside
 * a string, and the generated catalog carries `@syndroo/provider-*` package
 * names as data. Neither is an import, and neither should fail the gate.
 */
export function collectImportSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  const staticImport = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/gu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']/gu;

  for (const match of text.matchAll(staticImport)) {
    const specifier = match[1] ?? match[2];

    if (specifier !== undefined) {
      specifiers.add(specifier);
    }
  }

  for (const match of text.matchAll(dynamicImport)) {
    if (match[1] !== undefined) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers];
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("data:");
}

/**
 * Verify a built artifact from disk alone.
 *
 * The gate calls this without building: it answers "does the published bundle
 * exist, is private Core compiled in rather than required, and does the artifact
 * leak a build path or an inlined dependency".
 */
export function verifyBundleArtifact(spec: BundleSpec, distDirectory = spec.distDir): string[] {
  const problems: string[] = [];
  const primary = spec.entries[0];

  if (primary === undefined) {
    return ["the bundle spec declares no entry points"];
  }

  const primaryOutput = path.join(distDirectory, primary.output);
  const info = path.join(distDirectory, spec.infoFile);
  const distLabel = path.basename(distDirectory);

  if (!existsSync(primaryOutput)) {
    return [`${packageRelative(primaryOutput)} is missing`];
  }

  if (!existsSync(info)) {
    return [`${packageRelative(info)} is missing`];
  }

  let record: BundleRecord;

  try {
    record = JSON.parse(readFileSync(info, "utf8")) as BundleRecord;
  } catch {
    return [`${packageRelative(info)} is not valid JSON`];
  }

  if (record.format !== spec.format) {
    problems.push(`${spec.infoFile} declares format ${JSON.stringify(record.format)}`);
  }

  const inlinedWorkspacePackages = record.inlinedWorkspacePackages ?? [];

  for (const name of spec.requiredInlined) {
    if (!inlinedWorkspacePackages.includes(name)) {
      problems.push(`${name} is not recorded as inlined`);
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(spec.packageDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = manifest.dependencies ?? {};

  for (const name of spec.requiredInlined) {
    if (dependencies[name] !== undefined) {
      problems.push(`${name} is listed as a runtime dependency`);
    }
  }

  for (const name of record.external ?? []) {
    if (dependencies[name] === undefined) {
      problems.push(`${name} is external but not declared as a runtime dependency`);
    }
  }

  const forbidden = spec.forbiddenImports.map((name) => ({ name, pattern: new RegExp(`^${escapeRegExp(name)}$`, "u") }));
  // A published `.d.ts` must never point at a package the JavaScript compiled in:
  // an embedder type-checking the tarball cannot resolve it there.
  const inlinedWorkspace = [...new Set([...spec.requiredInlined, ...inlinedWorkspacePackages])];
  // Nor may it point at *any* other workspace package the manifest does not
  // declare: an embedder has no `packages/` directory to fall back to.
  const declaredDependencies = new Set(Object.keys(dependencies));

  for (const relative of listRelative(distDirectory)) {
    if (!spec.allowedExtensions.some((extension) => relative.endsWith(extension))) {
      problems.push(`unexpected artifact file ${distLabel}/${relative}`);
      continue;
    }

    const text = readFileSync(path.join(distDirectory, relative), "utf8");

    if (text.includes(ROOT)) {
      problems.push(`${distLabel}/${relative} embeds the absolute build path`);
    }

    if (relative.endsWith(".d.ts")) {
      for (const specifier of collectImportSpecifiers(text)) {
        if (inlinedWorkspace.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
          problems.push(`${distLabel}/${relative} still imports the inlined package ${specifier}`);
          continue;
        }

        const owner = workspacePackageName(specifier);

        if (owner !== undefined && owner !== spec.name && !declaredDependencies.has(owner)) {
          problems.push(
            `${distLabel}/${relative} imports ${specifier}, but ${owner} is not a declared dependency of ${spec.name}`,
          );
        }
      }

      continue;
    }

    if (!relative.endsWith(".js")) {
      continue;
    }

    for (const specifier of collectImportSpecifiers(text)) {
      if (spec.rejectNodeImports === true && specifier.startsWith("node:")) {
        problems.push(`${distLabel}/${relative} still imports the Node built-in ${specifier}`);
        continue;
      }

      if (isBareSpecifier(specifier)) {
        if (spec.rejectExternalImports === true) {
          problems.push(`${distLabel}/${relative} still imports the external package ${specifier}`);
          continue;
        }

        const match = forbidden.find((entry) => entry.pattern.test(specifier));

        if (match !== undefined) {
          problems.push(`${distLabel}/${relative} still imports ${match.name}`);
        }
      }
    }
  }

  if (spec.shebang !== undefined && !readFileSync(path.join(distDirectory, spec.shebang), "utf8").startsWith("#!")) {
    problems.push(`${distLabel}/${spec.shebang} lost its shebang`);
  }

  return problems;
}

/**
 * Verify the bundle *step* without building anything: the manifest must run the
 * bundler, must keep private Core out of `dependencies`, and must keep Core as a
 * devDependency so the bundled source stays owned by the build.
 */
export function verifyBundleStep(spec: BundleSpec): string[] {
  const problems: string[] = [];
  let manifest: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const manifestPath = path.join(spec.packageDir, "package.json");

  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [`${packageRelative(manifestPath)} is unreadable`];
  }

  if (!String(manifest.scripts?.build ?? "").includes(spec.generator)) {
    problems.push(`scripts.build does not run ${spec.generator}`);
  }

  for (const name of spec.requiredInlined) {
    if (manifest.dependencies?.[name] !== undefined) {
      problems.push(`${name} is a runtime dependency`);
    }

    if (manifest.devDependencies?.[name] === undefined) {
      problems.push(`the private ${spec.coreLabel ?? name} is not a devDependency, so nothing owns the bundled source`);
    }
  }

  return problems;
}

/**
 * The built-artifact status: `built` is false when this tree has no bundle yet,
 * which is "not built here" rather than a failure. Once the artifact exists its
 * problems are returned.
 */
export function bundleStatus(spec: BundleSpec, distDirectory = spec.distDir): {
  readonly built: boolean;
  readonly problems: readonly string[];
} {
  if (!existsSync(path.join(distDirectory, spec.infoFile))) {
    return { built: false, problems: [] };
  }

  return { built: true, problems: verifyBundleArtifact(spec, distDirectory) };
}

function runTsc(packageDir: string, tsconfig: string): number {
  const tsc = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const result = spawnSync(existsSync(tsc) ? tsc : "tsc", ["-p", path.join(packageDir, tsconfig)], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  return result.status ?? 1;
}

/**
 * Build the artifact. Returns the written bundle record. Throws when the
 * artifact is not publishable, so a broken bundle fails the build instead of
 * shipping.
 */
export async function bundlePackage(spec: BundleSpec): Promise<BundleRecord> {
  await rm(spec.distDir, { recursive: true, force: true });

  try {
    return await writeBundle(spec);
  } catch (error) {
    // A failed build must not leave a half-written artifact behind. The gate
    // keys "built" on the bundle record, so a leftover tree would otherwise be
    // reported as PENDING instead of as the broken artifact it is.
    await rm(spec.distDir, { recursive: true, force: true });
    throw error;
  }
}

async function writeBundle(spec: BundleSpec): Promise<BundleRecord> {
  if (spec.declarationsTsconfig !== undefined) {
    const typeExit = runTsc(spec.packageDir, spec.declarationsTsconfig);

    if (typeExit !== 0) {
      throw new Error(`tsc -p ${packageRelative(path.join(spec.packageDir, spec.declarationsTsconfig))} failed with exit ${typeExit}`);
    }
  }

  // Loaded lazily: `scripts/check-v1.ts` imports the verification helpers and
  // must not pull a bundler into the check graph.
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: spec.entries.map((entry) => ({ in: entry.source, out: entry.output.replace(/\.js$/u, "") })),
    outdir: spec.distDir,
    absWorkingDir: spec.packageDir,
    bundle: true,
    platform: spec.platform,
    format: "esm",
    target: spec.target,
    external: spec.external.flatMap((name) => [name, `${name}/*`]),
    ...(spec.aliasNodeBuiltins ? { alias: NODE_BUILTIN_ALIASES } : {}),
    splitting: false,
    metafile: true,
    logLevel: "warning",
  });

  const metafile = result.metafile as EsbuildMetafile;

  if (spec.rejectNodeImports === true) {
    for (const input of Object.keys(metafile.inputs ?? {})) {
      if (/(?:^|\/)node:/u.test(input)) {
        throw new Error("WORKER_NODE_IMPORT");
      }
    }
  }

  if (spec.rejectExternalImports === true) {
    for (const output of Object.values(metafile.outputs ?? {})) {
      if ((output.imports ?? []).length > 0) {
        throw new Error("WORKER_EXTERNAL_IMPORT");
      }
    }
  }

  const record = bundleRecord(spec, metafile);
  await mkdir(spec.distDir, { recursive: true });
  await writeFile(path.join(spec.distDir, spec.infoFile), `${JSON.stringify(record, null, 2)}\n`);

  // The public declarations were emitted by `tsc` above and still reference the
  // private workspace packages by name. An embedder type-checking the tarball
  // has no `@syndroo/core`, so copy every inlined package's declarations into
  // the artifact and rewrite the specifiers to relative paths. `verifyBundleArtifact`
  // below refuses the artifact if any inlined specifier survives.
  await inlineWorkspaceDeclarations(spec.distDir, record.inlinedWorkspacePackages);

  for (const relative of spec.chmod ?? []) {
    chmodSync(path.join(spec.distDir, relative), 0o755);
  }

  const problems = verifyBundleArtifact(spec);

  if (problems.length > 0) {
    throw new Error(`the ${spec.label} bundle is not publishable:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }

  return record;
}
