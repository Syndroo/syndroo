import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, parseStrictJson } from "@syndroo/core";
import type { Json } from "@syndroo/provider-sdk";
import { isMissing, reject } from "./errors.js";
import type { ProviderLoaderCode } from "./errors.js";
import type { BuiltinProviderCatalogEntry, DependencySnapshot, Inspection, NodeProviderOptions } from "./types.js";

const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", "test", "tests", "__tests__", "spec", "specs", "__specs__"]);
const LOCK_NAMES = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const MAX_FILES = 8192;
const MAX_ENTRIES = 16384;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_PACKAGES = 128;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Bounds for the manifest `files` allowlist that defines the shipped set. */
const MAX_FILES_PATTERNS = 64;
const MAX_FILES_PATTERN_LENGTH = 256;

export function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestJson(value: unknown): string {
  return digest(canonicalJson(value as Json));
}

export function validProvider(provider: string): boolean {
  return typeof provider === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(provider);
}

function record(value: unknown, code: ProviderLoaderCode): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject(code);
  return value as Record<string, unknown>;
}

/** Source reads are bounded, nonblocking, and do not follow a replaced leaf symlink. */
async function readRegular(file: string, limit: number, code: ProviderLoaderCode): Promise<Buffer> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return reject(code);
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - length));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) return reject(code);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const currentPath = await fs.lstat(file);
    if (currentPath.isSymbolicLink() || currentPath.ino !== stat.ino || currentPath.dev !== stat.dev
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return reject(code);
    return Buffer.concat(chunks, length);
  } catch {
    return reject(code);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function json(bytes: Buffer, code: ProviderLoaderCode): Record<string, unknown> {
  try { return record(parseStrictJson(bytes), code); } catch { return reject(code); }
}

export interface Selection {
  readonly roots: ReadonlyMap<string, { root: string; builtin?: BuiltinProviderCatalogEntry }>;
  readonly configFingerprint: string;
  readonly configDirectory: string;
}

export async function selectProviders(options: NodeProviderOptions): Promise<Selection> {
  // A missing configuration file is not invalid configuration. The default file
  // is allowed to be absent, and the built-in catalog has to answer anyway:
  // `status` lists the official providers, and `--provider` reports on one,
  // without a config file on the machine. An absent file simply means "no
  // provider override", so the catalog alone decides. Every other read failure
  // (a directory, a symlink, a permissions error) stays fatal.
  const present = await fs.lstat(options.configFile).then(
    () => true,
    (error: unknown) => (isMissing(error) ? false : reject("PROVIDER_CONFIG_INVALID")),
  );
  const bytes = present ? await readRegular(options.configFile, 65536, "PROVIDER_CONFIG_INVALID") : null;
  const config = bytes === null ? {} : json(bytes, "PROVIDER_CONFIG_INVALID");
  const entries = config.providers === undefined ? {} : record(config.providers, "PROVIDER_CONFIG_INVALID");
  // An absent file has no directory to canonicalize; relative overrides cannot
  // exist without it, and the fallback is only used for read-only lock lookups
  // that already tolerate a missing directory.
  const configDirectory = present
    ? await fs.realpath(path.dirname(options.configFile)).catch(() => reject("PROVIDER_CONFIG_INVALID"))
    : path.dirname(options.configFile);
  const roots = new Map<string, { root: string; builtin?: BuiltinProviderCatalogEntry }>();
  for (const builtin of options.catalog ?? []) roots.set(builtin.provider, { root: builtin.resolvedRoot, builtin });
  for (const [provider, value] of Object.entries(entries)) {
    if (!validProvider(provider)) return reject("PROVIDER_CONFIG_INVALID");
    const entry = record(value, "PROVIDER_CONFIG_INVALID");
    if (Object.keys(entry).length !== 1 || typeof entry.path !== "string" || !entry.path
      || entry.path.length > 4096 || /[\x00-\x1f\x7f]/.test(entry.path) || /^[a-z]+:/i.test(entry.path)) {
      return reject("PROVIDER_CONFIG_INVALID");
    }
    // Overrides replace catalog entries, including their provenance, before any inspection.
    roots.set(provider, { root: path.resolve(configDirectory, entry.path) });
  }
  if (roots.size > 100) return reject("PROVIDER_CONFIG_INVALID");
  return { roots, configDirectory, configFingerprint: bytes === null ? digestJson({ absent: true }) : digest(bytes) };
}

interface PackageData {
  root: string;
  name: string;
  version: string;
  metadata: Record<string, unknown>;
  fingerprint: string;
  files: Map<string, string>;
  dependencies: Record<string, string | null>;
}

/**
 * One compiled `files` entry: a glob, plus the directory form of the same glob
 * (`dist` ships `dist` and everything below it).
 */
interface FilesMatcher {
  readonly negated: boolean;
  readonly self: RegExp;
  readonly below: RegExp;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile one `files` glob; `*` stays inside a path segment and `**` crosses. */
function globRegex(pattern: string): RegExp {
  const body = escapeRegex(pattern)
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");

  return new RegExp(`^${body}$`);
}

/**
 * The `files` allowlist of a manifest, validated and compiled, or `null` when
 * the manifest declares none.
 *
 * npm ships exactly these paths, expanded, plus `package.json` (and the small
 * always-included README/LICENSE/NOTICE set). The artifact fingerprint covers
 * that declared set plus `package.json` and nothing else, which is what makes a
 * repository checkout and an installed tarball of the same package hash the
 * same bytes: `src/`, `tsconfig*.json` and other repository-only files are no
 * longer part of the artifact digest.
 *
 * `null` keeps the older "every walked file" rule for a package that declares
 * no `files` field, where npm's own publication set cannot be derived from the
 * manifest alone.
 */
function filesMatchers(metadata: Record<string, unknown>): readonly FilesMatcher[] | null {
  const raw = metadata.files;

  if (raw === undefined) {
    return null;
  }

  if (!Array.isArray(raw) || raw.length > MAX_FILES_PATTERNS) {
    return reject("PROVIDER_METADATA_INVALID");
  }

  const matchers: FilesMatcher[] = [];

  for (const entry of raw) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_FILES_PATTERN_LENGTH ||
      /[\u0000-\u001f\u007f\\]/.test(entry)
    ) {
      return reject("PROVIDER_METADATA_INVALID");
    }

    const negated = entry.startsWith("!");
    const body = (negated ? entry.slice(1) : entry)
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");

    if (
      body.length === 0 ||
      body.startsWith("/") ||
      body.split("/").some((part) => part === ".." || part === "node_modules")
    ) {
      return reject("PROVIDER_METADATA_INVALID");
    }

    matchers.push({ negated, self: globRegex(body), below: globRegex(`${body}/**`) });
  }

  return matchers;
}

/** True when a relative path is inside the declared `files` set. */
function isShipped(matchers: readonly FilesMatcher[], relative: string): boolean {
  if (relative === "package.json") {
    return true;
  }

  let included = false;

  for (const matcher of matchers) {
    if (matcher.self.test(relative) || matcher.below.test(relative)) {
      included = !matcher.negated;
    }
  }

  return included;
}

function packageName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

function version(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

async function readPackage(root: string, budget: { files: number; entries: number; bytes: number }): Promise<PackageData> {
  const files = new Map<string, string>();
  let metadataBytes: Buffer | undefined;
  async function walk(relative: string, depth = 0): Promise<void> {
    if (depth > MAX_DIRECTORY_DEPTH) return reject("PROVIDER_ARTIFACT_INVALID");
    const directory = path.join(root, relative);
    if (!(await fs.lstat(directory)).isDirectory()) return reject("PROVIDER_ARTIFACT_INVALID");
    const names: string[] = [];
    for await (const entry of await fs.opendir(directory)) {
      if (++budget.entries > MAX_ENTRIES) return reject("PROVIDER_ARTIFACT_INVALID");
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const full = path.join(root, rel);
      const stat = await fs.lstat(full);
      if (name.toLowerCase() === "node_modules" && relative) return reject("PROVIDER_ARTIFACT_INVALID");
      if (stat.isDirectory() && EXCLUDED_DIRECTORIES.has(name.toLowerCase())) continue;
      if (stat.isSymbolicLink()) return reject("PROVIDER_ARTIFACT_INVALID");
      if (stat.isDirectory()) { await walk(rel, depth + 1); continue; }
      if (!stat.isFile() || ++budget.files > MAX_FILES) return reject("PROVIDER_ARTIFACT_INVALID");
      const bytes = await readRegular(full, rel === "package.json" ? 65536 : MAX_FILE_BYTES, "PROVIDER_ARTIFACT_INVALID");
      budget.bytes += bytes.length;
      if (budget.bytes > MAX_ARTIFACT_BYTES) return reject("PROVIDER_ARTIFACT_INVALID");
      files.set(rel, digest(bytes));
      if (rel === "package.json") metadataBytes = bytes;
    }
  }
  try { await walk(""); } catch { return reject("PROVIDER_ARTIFACT_INVALID"); }
  if (!metadataBytes) return reject("PROVIDER_METADATA_INVALID");
  const metadata = json(metadataBytes, "PROVIDER_METADATA_INVALID");
  if (!packageName(metadata.name) || !version(metadata.version)) return reject("PROVIDER_METADATA_INVALID");
  // Two maps, two jobs: `files` is the whole walked tree (entrypoint and
  // `exports` validation), `shipped` is the published artifact set that the
  // artifact fingerprint covers.
  const matchers = filesMatchers(metadata);
  const shipped = matchers === null ? files : new Map([...files].filter(([rel]) => isShipped(matchers, rel)));
  return {
    root, name: metadata.name, version: metadata.version, metadata, files,
    fingerprint: digestJson([...shipped]), dependencies: Object.create(null),
  };
}

function entrypoint(metadata: Record<string, unknown>, files: ReadonlyMap<string, string>): string {
  let target: unknown = metadata.main;
  if (Object.hasOwn(metadata, "exports")) {
    const exports = metadata.exports;
    target = exports && typeof exports === "object" && !Array.isArray(exports) && Object.hasOwn(exports, ".")
      ? (exports as Record<string, unknown>)["."] : exports;
  }
  const targets = new Set<string>();
  function visit(value: unknown): void {
    if (typeof value === "string") { targets.add(value); return; }
    const conditions = record(value, "PROVIDER_ENTRYPOINT_INVALID");
    let found = false;
    for (const [key, branch] of Object.entries(conditions)) {
      if (["node", "import", "default"].includes(key)) { found = true; visit(branch); }
      else if (!["types", "require", "browser"].includes(key)) return reject("PROVIDER_ENTRYPOINT_INVALID");
    }
    if (!found) return reject("PROVIDER_ENTRYPOINT_INVALID");
  }
  visit(target);
  if (targets.size !== 1) return reject("PROVIDER_ENTRYPOINT_INVALID");
  const entry = [...targets][0]!;
  if (!entry.startsWith("./") || /[\\%?#\x00-\x1f]/.test(entry) || entry.split("/").some(p => p === ".." || p === "node_modules")
    || !/\.(?:mjs|js)$/.test(entry) || (entry.endsWith(".js") && metadata.type !== "module")
    || !files.has(entry.slice(2))) return reject("PROVIDER_ENTRYPOINT_INVALID");
  return entry;
}

function declaredDependencies(metadata: Record<string, unknown>): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const peersMeta = metadata.peerDependenciesMeta === undefined ? {} : record(metadata.peerDependenciesMeta, "PROVIDER_DEPENDENCY_INVALID");
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    if (metadata[field] === undefined) continue;
    for (const [name, range] of Object.entries(record(metadata[field], "PROVIDER_DEPENDENCY_INVALID"))) {
      if (!packageName(name) || typeof range !== "string" || !range || range.length > 1024) return reject("PROVIDER_DEPENDENCY_INVALID");
      const optional = field === "optionalDependencies" || (field === "peerDependencies"
        && !!peersMeta[name] && record(peersMeta[name], "PROVIDER_DEPENDENCY_INVALID").optional === true);
      result.set(name, field === "optionalDependencies" ? true : result.has(name) ? result.get(name)! && optional : optional);
    }
  }
  return new Map([...result].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** Check only exact declared package paths; never enumerate node_modules or resolve imports. */
async function dependencyRoot(from: string, name: string): Promise<string | null> {
  const directories = new Set<string>();
  let current = from;
  while (true) {
    directories.add(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of directories) {
    const candidate = path.join(directory, "node_modules", name);
    try {
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isDirectory()) return reject("PROVIDER_DEPENDENCY_INVALID");
      return resolved;
    } catch (error) {
      if (!isMissing(error)) return reject("PROVIDER_DEPENDENCY_INVALID");
    }
  }
  return null;
}

export async function inspectSelected(provider: string, selection: Selection): Promise<Inspection> {
  const selected = selection.roots.get(provider);
  if (!selected) return reject("PROVIDER_UNAVAILABLE");
  let root: string;
  try { root = await fs.realpath(selected.root); } catch { return reject("PROVIDER_UNAVAILABLE"); }
  const packages = new Map<string, PackageData>();
  const pending = [root];
  const budget = { files: 0, entries: 0, bytes: 0 };
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > MAX_PACKAGES) return reject("PROVIDER_DEPENDENCY_INVALID");
    const packageRoot = pending[index]!;
    const pkg = await readPackage(packageRoot, budget);
    packages.set(packageRoot, pkg);
    for (const [name, optional] of declaredDependencies(pkg.metadata)) {
      const dependency = name === pkg.name && pkg.metadata.exports !== undefined
        ? packageRoot : await dependencyRoot(packageRoot, name);
      if (!dependency && !optional) return reject("PROVIDER_DEPENDENCY_INVALID");
      pkg.dependencies[name] = dependency;
      if (dependency && !pending.includes(dependency)) pending.push(dependency);
    }
  }
  const main = packages.get(root)!;
  for (const pkg of packages.values()) {
    for (const [name, dependency] of Object.entries(pkg.dependencies)) {
      if (dependency && packages.get(dependency)?.name !== name) return reject("PROVIDER_DEPENDENCY_INVALID");
    }
  }
  const entry = entrypoint(main.metadata, main.files);
  const locks: { path: string; fingerprint: string }[] = [];
  for (const directory of new Set([selection.configDirectory, root])) {
    for (const name of LOCK_NAMES) {
      const target = path.join(directory, name);
      try { await fs.lstat(target); } catch (error) { if (isMissing(error)) continue; return reject("PROVIDER_DEPENDENCY_INVALID"); }
      locks.push({ path: target, fingerprint: digest(await readRegular(target, MAX_FILE_BYTES, "PROVIDER_DEPENDENCY_INVALID")) });
    }
  }
  const dependencySnapshot: DependencySnapshot = {
    policy: "syndroo-artifact-v1",
    packages: [...packages.values()].map(p => ({ resolvedRoot: p.root, name: p.name, version: p.version,
      fingerprint: p.fingerprint, dependencies: p.dependencies })),
    locks,
  };
  // Installation paths belong to approval binding, not to the relocatable distribution digest.
  const artifactFingerprint = digestJson({ name: main.name, version: main.version, entrypoint: entry,
    packages: [...packages.values()].map(p => ({ name: p.name, version: p.version, fingerprint: p.fingerprint,
      dependencies: Object.fromEntries(Object.entries(p.dependencies).map(([name, location]) =>
        [name, location === null ? null : pending.indexOf(location)])) })) });
  return {
    candidate: { provider, packageName: main.name, version: main.version, resolvedRoot: root, entrypoint: entry,
      artifactFingerprint, provenance: selected.builtin ? "official" : "third_party" },
    configFingerprint: selection.configFingerprint, dependencySnapshot, entrypointHash: main.files.get(entry.slice(2))!,
    ...(selected.builtin ? { builtin: selected.builtin } : {}),
  };
}
