import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

export const PACKAGE_NAME = "@syndroo/cloudflare-worker";
export const PACKAGE_PATH = "packages/cloudflare-worker";
export const REPOSITORY_MARKERS = [
  "wrangler.jsonc",
  "package.json",
] as const;

export type WorkerBundlePlan = {
  readonly repositoryRoot: string;
  readonly configPath: string;
  readonly outputDirectory: string;
  readonly wranglerArguments: readonly string[];
};

export type BundledSource = {
  readonly source: string;
  readonly packageName: string;
  readonly packageRoot: string;
  // False when the bundled file is not published, for example when a
  // dependency shipped a source map that points at its own TypeScript sources.
  readonly fileExists: boolean;
};

export type Violation = {
  readonly code: string;
  readonly detail: string;
};

// Wrangler resolves `--outdir` relative to the directory of the `--config`
// file, not relative to the working directory. Syndroo keeps its single
// production manifest at the repository root, so a relative `--outdir` writes
// the bundle into the root `dist/` and leaves the published package with a
// stale artifact. Always hand Wrangler an absolute path.
export function planWorkerBundle(repositoryRoot: string): WorkerBundlePlan {
  const root = resolve(repositoryRoot);
  const configPath = resolve(root, "wrangler.jsonc");
  const outputDirectory = resolve(root, PACKAGE_PATH, "dist");

  return {
    repositoryRoot: root,
    configPath,
    outputDirectory,
    wranglerArguments: [
      "deploy",
      "--dry-run",
      "--outdir",
      outputDirectory,
      "--config",
      configPath,
    ],
  };
}

export function resolveRepositoryRoot(startDirectory: string): string {
  let candidate = resolve(startDirectory);

  for (;;) {
    if (
      existsSync(resolve(candidate, PACKAGE_PATH, "package.json")) &&
      REPOSITORY_MARKERS.every((marker) =>
        existsSync(resolve(candidate, marker)),
      )
    ) {
      return candidate;
    }

    const parent = resolve(candidate, "..");

    if (parent === candidate) {
      throw new Error(
        `Could not locate the Syndroo repository root above ${JSON.stringify(startDirectory)}.`,
      );
    }

    candidate = parent;
  }
}

// Source map paths are relative to the directory that holds the map. Wrangler
// also records a `sourceRoot`, which repeats the output directory name, so the
// raw and the sourceRoot-prefixed candidates are both checked on disk.
export function sourceFileCandidates(
  mapDirectory: string,
  sourceRoot: string | undefined,
  source: string,
): string[] {
  const base = resolve(mapDirectory);
  const candidates: string[] = [];

  if (sourceRoot !== undefined && sourceRoot.length > 0) {
    candidates.push(resolve(base, sourceRoot, source));
  }

  candidates.push(resolve(base, source));

  return [...new Set(candidates)];
}

export function resolveSourceFile(
  mapDirectory: string,
  sourceRoot: string | undefined,
  source: string,
): string | undefined {
  const candidates = sourceFileCandidates(mapDirectory, sourceRoot, source);

  return candidates.find((candidate) => existsSync(candidate));
}

// The package root is the path segment right after the innermost `node_modules`
// directory, which identifies the exact installed instance, including nested
// versions. Walking up to the nearest package.json is not equivalent: published
// packages such as @babel/runtime ship nested manifests (`helpers/esm`) that are
// not package roots. The derived directory only counts when it exists on disk.
export function derivePackageRoot(
  mapDirectory: string,
  sourceRoot: string | undefined,
  source: string,
): string | undefined {
  for (const candidate of sourceFileCandidates(
    mapDirectory,
    sourceRoot,
    source,
  )) {
    const marker = `${sep}node_modules${sep}`;
    const index = candidate.lastIndexOf(marker);

    if (index < 0) {
      continue;
    }

    const [first, second] = candidate.slice(index + marker.length).split(sep);

    if (first === undefined || first.length === 0) {
      continue;
    }

    const name = first.startsWith("@")
      ? second === undefined
        ? undefined
        : `${first}${sep}${second}`
      : first;

    if (name === undefined) {
      continue;
    }

    const packageRoot = `${candidate.slice(0, index)}${marker}${name}`;

    if (existsSync(resolve(packageRoot, "package.json"))) {
      return packageRoot;
    }
  }

  return undefined;
}

export function derivePackageRootFromFile(
  filePath: string,
): string | undefined {
  const marker = `${sep}node_modules${sep}`;
  const index = resolve(filePath).lastIndexOf(marker);

  if (index < 0) {
    return undefined;
  }

  const [first, second] = resolve(filePath)
    .slice(index + marker.length)
    .split(sep);
  const name =
    first === undefined || first.length === 0
      ? undefined
      : first.startsWith("@")
        ? second === undefined
          ? undefined
          : `${first}${sep}${second}`
        : first;

  if (name === undefined) {
    return undefined;
  }

  const packageRoot = `${resolve(filePath).slice(0, index)}${marker}${name}`;

  return existsSync(resolve(packageRoot, "package.json"))
    ? packageRoot
    : undefined;
}

export function packageNameFromRoot(packageRoot: string): string | undefined {
  const segments = resolve(packageRoot).split(sep);
  const marker = segments.lastIndexOf("node_modules");

  if (marker < 0) {
    return undefined;
  }

  const first = segments[marker + 1];
  const second = segments[marker + 2];

  if (first === undefined || first.length === 0) {
    return undefined;
  }

  if (first.startsWith("@")) {
    return second === undefined || second.length === 0
      ? undefined
      : `${first}/${second}`;
  }

  return first;
}

export function collectBundledSources(
  sourceMapJson: unknown,
  mapDirectory: string,
): { sources: BundledSource[]; unresolved: string[] } {
  if (typeof sourceMapJson !== "object" || sourceMapJson === null) {
    throw new Error("Worker source map must be a JSON object.");
  }

  const record = sourceMapJson as { sources?: unknown; sourceRoot?: unknown };
  const sources = record.sources;

  if (!Array.isArray(sources)) {
    throw new Error("Worker source map has no `sources` array.");
  }

  const sourceRoot =
    typeof record.sourceRoot === "string" ? record.sourceRoot : undefined;
  const collected: BundledSource[] = [];
  const unresolved: string[] = [];

  for (const source of sources) {
    if (typeof source !== "string") {
      continue;
    }

    // Published dependencies sometimes ship a source map that points at
    // build-time TypeScript sources they do not include, so the path prefix is
    // used when the exact file is absent.
    const resolvedPath = resolveSourceFile(mapDirectory, sourceRoot, source);
    const fromFile =
      resolvedPath === undefined
        ? undefined
        : derivePackageRootFromFile(resolvedPath);
    const packageRoot =
      fromFile ?? derivePackageRoot(mapDirectory, sourceRoot, source);

    if (packageRoot === undefined) {
      // Repository-owned sources and other non-package inputs are not
      // third-party code and carry no separate license obligation here.
      if (source.includes("/node_modules/")) {
        unresolved.push(source);
      }

      continue;
    }

    const packageName = packageNameFromRoot(packageRoot);

    if (packageName === undefined) {
      unresolved.push(source);
      continue;
    }

    collected.push({
      source,
      packageName,
      packageRoot,
      fileExists: fromFile !== undefined,
    });
  }

  return { sources: collected, unresolved };
}

const LICENSE_FILE_PATTERN =
  /^(licen[cs]es?|copying|unlicense)([-._][a-z0-9][a-z0-9._-]*)?$/i;
const NOTICE_FILE_PATTERN =
  /^(notice|copyr?ight|authors|contributors)([-._][a-z0-9][a-z0-9._-]*)?$/i;

export type LicenseArtifacts = {
  readonly licenseFiles: string[];
  readonly noticeFiles: string[];
};

// License obligations are not satisfied by a NOTICE or COPYRIGHT file alone,
// so the two groups stay separate: at least one license file is mandatory,
// and notice files are bundled alongside it when the package ships them.
export function selectLicenseArtifacts(
  names: readonly string[],
): LicenseArtifacts {
  const licenseFiles: string[] = [];
  const noticeFiles: string[] = [];

  for (const name of names) {
    // `LICENSE`, `LICENSE-MIT`, `COPYING`, `NOTICE.txt` and similar names are
    // all recognized; other files are ignored, never substituted for a license.
    const stem = stripKnownExtension(name);

    if (LICENSE_FILE_PATTERN.test(stem)) {
      licenseFiles.push(name);
      continue;
    }

    if (NOTICE_FILE_PATTERN.test(stem)) {
      noticeFiles.push(name);
    }
  }

  return {
    licenseFiles: licenseFiles.sort(),
    noticeFiles: noticeFiles.sort(),
  };
}

// Drops a trailing document extension such as `.txt`, `.md`, or `.html`, while
// keeping versioned names like `LICENSE-2.0` intact.
function stripKnownExtension(name: string): string {
  return name.replace(/\.(txt|md|markdown|rst|html?)$/i, "");
}

export type LicenseEntry = {
  readonly name: string;
  readonly version: string;
  readonly declaredLicense: string | undefined;
  readonly relativeDirectory: string;
  readonly files: ReadonlyArray<{ readonly fileName: string; readonly text: string }>;
  // Set when the shipped text is not the package's own file, for example when a
  // reviewed supplement supplies the standard terms the package declares.
  readonly textSource: string | undefined;
};

export function renderThirdPartyLicenses(
  entries: readonly LicenseEntry[],
  generatedFor: string,
): string {
  const lines = [
    "THIRD-PARTY LICENSES",
    "====================",
    "",
    `Bundled into ${generatedFor}.`,
    "",
    "Generated from the built Worker bundle source map by `npm run",
    "build:package`. Every package listed here contributes modules to the",
    "shipped bundle. Each text is copied verbatim from the installed package,",
    "except where a `text source:` line records a reviewed supplement for a",
    "package that ships no license file of its own.",
    "",
    `Included packages: ${String(entries.length)}`,
    "",
  ];

  for (const entry of entries) {
    lines.push(
      separator(),
      `${entry.name} ${entry.version}`,
      `installed at: ${entry.relativeDirectory}`,
      `declared license: ${entry.declaredLicense ?? "not declared in package.json"}`,
      `included files: ${entry.files.map((file) => file.fileName).join(", ") || "none"}`,
      ...(entry.textSource === undefined ? [] : [`text source: ${entry.textSource}`]),
      separator(),
      "",
    );

    for (const file of entry.files) {
      lines.push(`--- ${file.fileName} ---`, "", file.text.replace(/\s+$/, ""), "");
    }
  }

  return lines.join("\n");
}

function separator(): string {
  return "-".repeat(78);
}

export function isInside(directory: string, candidate: string): boolean {
  const parent = resolve(directory);
  const target = resolve(candidate);

  return (
    target === parent ||
    target.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  );
}

const LEAK_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: "workspace-protocol", pattern: /"workspace:[^"]+"/ },
  { code: "experiment-path", pattern: /(^|["'\s/])experiments\/[a-z0-9-]+/i },
  {
    code: "absolute-home-path",
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
  },
  {
    code: "account-id-json",
    pattern: /"account_id"\s*:\s*"[0-9a-f]{32}"/i,
  },
  {
    code: "database-id-json",
    pattern: /"database_id"\s*:\s*"[0-9a-f-]{36}"/i,
  },
  {
    code: "api-key-assignment",
    pattern: /SYNDROO_API_KEY"?\s*[:=]\s*["'][^"'\s]{8,}["']/,
  },
];

export function findTextViolations(text: string, label: string): Violation[] {
  return LEAK_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ code }) => ({
      code,
      detail: `${label} matched ${code}`,
    }),
  );
}
