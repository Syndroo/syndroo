#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  collectBundledSources,
  isInside,
  type LicenseEntry,
  PACKAGE_NAME,
  PACKAGE_PATH,
  planWorkerBundle,
  renderThirdPartyLicenses,
  resolveRepositoryRoot,
  selectLicenseArtifacts,
} from "./package-support.js";

const repositoryRoot = resolveRepositoryRoot(process.cwd());
const plan = planWorkerBundle(repositoryRoot);
const packageDirectory = resolve(repositoryRoot, PACKAGE_PATH);
const bundlePath = resolve(plan.outputDirectory, "index.js");
const sourceMapPath = resolve(plan.outputDirectory, "index.js.map");
const licensePath = resolve(plan.outputDirectory, "THIRD_PARTY_LICENSES.txt");
const licensesDirectory = resolve(packageDirectory, "licenses");
const supplementPath = resolve(
  licensesDirectory,
  "third-party-license-supplements.json",
);

for (const required of [bundlePath, sourceMapPath]) {
  if (!existsSync(required)) {
    throw new Error(
      `Missing ${required}.\nRun \`npm run build:package\` before generating licenses.`,
    );
  }
}

const sourceMap: unknown = JSON.parse(await readFile(sourceMapPath, "utf8"));
const { sources, unresolved } = collectBundledSources(
  sourceMap,
  dirname(sourceMapPath),
);

const unresolvedPackages = unresolved.filter((source) =>
  source.includes("/node_modules/"),
);

if (unresolvedPackages.length > 0) {
  throw new Error(
    [
      "Refusing to generate licenses from a partially resolvable source map.",
      "These bundled sources do not exist on disk:",
      ...unresolvedPackages.map((source) => `  - ${source}`),
    ].join("\n"),
  );
}

const packageRoots = new Map<string, string>();

for (const bundled of sources) {
  packageRoots.set(bundled.packageRoot, bundled.packageName);
}

const entries: LicenseEntry[] = [];
const failures: string[] = [];
const supplements = await readLicenseSupplements(supplementPath);

for (const [packageRoot, packageName] of packageRoots) {
  const relativeDirectory = displayPath(repositoryRoot, packageRoot);
  const manifest = await readPackageManifest(packageRoot);
  const included = selectLicenseArtifacts(await listFileNames(packageRoot));

  if (included.licenseFiles.length === 0) {
    const identity = `${manifest.name ?? packageName}@${manifest.version ?? "unknown"}`;
    const supplement = supplements.get(identity);

    // Some packages ship no license text at all. That is only acceptable for an
    // exact reviewed version, and the terms still have to reach the package, so
    // a recorded supplement supplies them. Everything else fails closed.
    if (
      supplement === undefined ||
      supplement.declaredLicense !== manifest.license
    ) {
      failures.push(
        `${identity} (${relativeDirectory}) has no LICENSE/COPYING/UNLICENSE text; found: ${(await listFileNames(packageRoot)).join(", ") || "no files"}`,
      );
      continue;
    }

    const supplementFile = resolve(licensesDirectory, supplement.licenseFile);

    if (!isInside(licensesDirectory, supplementFile) || !existsSync(supplementFile)) {
      failures.push(
        `${identity} references an unusable supplemental license file ${supplement.licenseFile}.`,
      );
      continue;
    }

    const text = await readFile(supplementFile, "utf8");
    const digest = createHash("sha256").update(text).digest("hex");

    if (digest !== supplement.sourceSha256) {
      failures.push(
        `${identity} supplemental ${supplement.licenseFile} does not match the recorded sha256 (${digest}).`,
      );
      continue;
    }

    entries.push({
      name: manifest.name ?? packageName,
      version: manifest.version ?? "unknown",
      declaredLicense: manifest.license,
      relativeDirectory,
      files: [{ fileName: `licenses/${supplement.licenseFile}`, text }],
      textSource: `${supplement.sourceUrl} (sha256 ${supplement.sourceSha256}). ${supplement.note}`,
    });
    continue;
  }

  const files = [...included.licenseFiles, ...included.noticeFiles];
  const gathered: Array<{ fileName: string; text: string }> = [];

  for (const fileName of files) {
    const text = await readFile(resolve(packageRoot, fileName), "utf8");

    if (text.trim().length === 0) {
      failures.push(`${packageName} (${relativeDirectory}) has an empty ${fileName}`);
      continue;
    }

    gathered.push({ fileName, text });
  }

  if (gathered.length !== files.length) {
    continue;
  }

  entries.push({
    name: manifest.name ?? packageName,
    version: manifest.version ?? "unknown",
    declaredLicense: manifest.license,
    relativeDirectory,
    files: gathered,
    textSource: undefined,
  });
}

if (failures.length > 0) {
  throw new Error(
    [
      "Refusing to package without complete third-party license text.",
      "Problems found in the bundled packages:",
      ...failures.map((failure) => `  - ${failure}`),
    ].join("\n"),
  );
}

entries.sort((left, right) =>
  `${left.name}@${left.version}@${left.relativeDirectory}`.localeCompare(
    `${right.name}@${right.version}@${right.relativeDirectory}`,
  ),
);

await writeFile(
  licensePath,
  renderThirdPartyLicenses(entries, `${PACKAGE_NAME} dist/index.js`),
  "utf8",
);

console.log(
  JSON.stringify(
    {
      package: PACKAGE_NAME,
      bundle: bundlePath,
      licenses: licensePath,
      packages: entries.map((entry) => `${entry.name}@${entry.version}`),
    },
    null,
    2,
  ),
);

type PackageManifest = {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
};

type LicenseSupplement = {
  readonly declaredLicense: string;
  readonly licenseFile: string;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly note: string;
};

async function readLicenseSupplements(
  path: string,
): Promise<Map<string, LicenseSupplement>> {
  const supplements = new Map<string, LicenseSupplement>();

  if (!existsSync(path)) {
    return supplements;
  }

  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const list = (value as { supplements?: unknown }).supplements;

  if (!Array.isArray(list)) {
    throw new Error(`${path} must contain a "supplements" array.`);
  }

  for (const item of list) {
    const record = item as Record<string, unknown>;
    const name = record["package"];
    const version = record["version"];
    const declaredLicense = record["declaredLicense"];
    const licenseFile = record["licenseFile"];
    const sourceUrl = record["sourceUrl"];
    const sourceSha256 = record["sourceSha256"];
    const note = record["note"];

    if (
      typeof name !== "string" ||
      typeof version !== "string" ||
      typeof declaredLicense !== "string" ||
      typeof licenseFile !== "string" ||
      typeof sourceUrl !== "string" ||
      typeof sourceSha256 !== "string" ||
      typeof note !== "string" ||
      note.trim().length === 0
    ) {
      throw new Error(
        `${path} has an incomplete supplement entry: ${JSON.stringify(item)}`,
      );
    }

    supplements.set(`${name}@${version}`, {
      declaredLicense,
      licenseFile,
      sourceUrl,
      sourceSha256,
      note,
    });
  }

  return supplements;
}

async function readPackageManifest(
  packageRoot: string,
): Promise<PackageManifest> {
  const value: unknown = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  );

  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;

  return {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["version"] === "string"
      ? { version: record["version"] }
      : {}),
    ...(typeof record["license"] === "string"
      ? { license: record["license"] }
      : {}),
  };
}

async function listFileNames(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  const files: string[] = [];

  for (const name of names) {
    const info = await stat(resolve(directory, name));

    if (info.isFile()) {
      files.push(name);
    }
  }

  return files.sort();
}

function displayPath(root: string, target: string): string {
  const relativePath = relative(root, target);

  return relativePath.startsWith("..") ? target : relativePath;
}
