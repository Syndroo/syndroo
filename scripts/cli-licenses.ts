import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  derivePackageRootFromFile,
  isInside,
  packageNameFromRoot,
  selectLicenseArtifacts,
} from "./package-support.js";

/**
 * Third-party notices for the self-contained CLI bundle.
 *
 * The list of bundled packages comes from the esbuild metafile, not from a
 * hand-maintained list, so a new transitive dependency cannot ship without its
 * license. A bundled package that ships no license text fails the build unless
 * a reviewed supplement records the exact version.
 */

export type BundledPackage = {
  readonly name: string;
  readonly version: string;
  readonly declaredLicense: string | undefined;
  readonly packageRoot: string;
  readonly relativeDirectory: string;
  readonly licenseFiles: readonly string[];
  readonly noticeFiles: readonly string[];
  readonly files: readonly { readonly fileName: string; readonly text: string }[];
  readonly supplement: LicenseSupplement | undefined;
};

export type LicenseSupplement = {
  readonly package: string;
  readonly version: string;
  readonly declaredLicense: string;
  readonly licenseFile: string;
  readonly sourceUrl: string;
  readonly note: string;
};

type EsbuildMetafile = {
  readonly inputs?: Readonly<Record<string, unknown>>;
};

/** Every third-party package that contributes a module to the bundle. */
export function collectBundledPackages(
  metafile: EsbuildMetafile,
  workingDirectory: string,
): readonly { readonly name: string; readonly packageRoot: string }[] {
  const inputs = metafile.inputs;

  if (inputs === undefined || Object.keys(inputs).length === 0) {
    throw new Error(
      "The esbuild metafile lists no inputs; refusing to generate notices from an empty bundle.",
    );
  }

  const roots = new Map<string, string>();

  for (const input of Object.keys(inputs)) {
    const absolute = resolve(workingDirectory, input);
    const packageRoot = derivePackageRootFromFile(absolute);

    if (packageRoot === undefined) {
      continue;
    }

    const name = packageNameFromRoot(packageRoot);

    if (name === undefined) {
      continue;
    }

    roots.set(packageRoot, name);
  }

  return [...roots]
    .map(([packageRoot, name]) => ({ name, packageRoot }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function describeBundledPackages(
  metafile: EsbuildMetafile,
  options: {
    readonly workingDirectory: string;
    readonly repositoryRoot: string;
    readonly supplementDirectory: string;
    readonly supplements: ReadonlyMap<string, LicenseSupplement>;
  },
): Promise<readonly BundledPackage[]> {
  const collected = collectBundledPackages(metafile, options.workingDirectory);
  const described: BundledPackage[] = [];
  const failures: string[] = [];

  for (const { name, packageRoot } of collected) {
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown; license?: unknown };
    const version =
      typeof manifest.version === "string" ? manifest.version : "unknown";
    // License candidates must be real files: a package can also ship a
    // `licenses/` directory, which is not license text to copy here.
    const artifactFiles: string[] = [];

    for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
      if (entry.isFile()) {
        artifactFiles.push(entry.name);
      }
    }

    const artifacts = selectLicenseArtifacts(artifactFiles);
    const supplement = options.supplements.get(`${name}@${version}`);

    if (artifacts.licenseFiles.length === 0 && supplement === undefined) {
      failures.push(`${name}@${version} ships no license file`);
    }

    const files: { fileName: string; text: string }[] = [];

    for (const fileName of [
      ...artifacts.licenseFiles,
      ...artifacts.noticeFiles,
    ]) {
      files.push({
        fileName,
        text: await readFile(resolve(packageRoot, fileName), "utf8"),
      });
    }

    if (artifacts.licenseFiles.length === 0 && supplement !== undefined) {
      const supplementPath = resolve(options.supplementDirectory, supplement.licenseFile);

      if (!existsSync(supplementPath)) {
        failures.push(
          `${name}@${version} records the supplement ${supplement.licenseFile}, which is missing`,
        );
      } else {
        files.push({
          fileName: supplement.licenseFile,
          text: await readFile(supplementPath, "utf8"),
        });
      }
    }

    described.push({
      name,
      version,
      declaredLicense:
        typeof manifest.license === "string" ? manifest.license : undefined,
      packageRoot,
      relativeDirectory: displayPath(options.repositoryRoot, packageRoot),
      licenseFiles: artifacts.licenseFiles,
      noticeFiles: artifacts.noticeFiles,
      files,
      supplement,
    });
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "Refusing to write third-party notices from a partially licensed bundle:",
        ...failures.map((failure) => `  - ${failure}`),
        "Add a reviewed supplement in packages/cli/licenses/third-party-license-supplements.json for the exact version.",
      ].join("\n"),
    );
  }

  return described;
}

export function renderCliThirdPartyNotices(
  entries: readonly BundledPackage[],
  generatedFor: string,
): string {
  const lines = [
    "THIRD-PARTY LICENSES",
    "====================",
    "",
    `Bundled into ${generatedFor}.`,
    "",
    "Generated from the esbuild metafile of the published CLI bundle. Every",
    "package listed here contributes a module to that bundle. Each text is",
    "copied verbatim from the installed package, except where a `text source:`",
    "line records a reviewed supplement for a package that ships no license",
    "file of its own.",
    "",
    "The Syndroo packages compiled into this bundle are repository-owned and",
    "covered by the LICENSE and NOTICE files shipped beside this one.",
    "",
    `Included third-party packages: ${String(entries.length)}`,
    "",
  ];

  for (const entry of entries) {
    lines.push(
      separator(),
      `${entry.name} ${entry.version}`,
      `installed at: ${entry.relativeDirectory}`,
      `declared license: ${entry.declaredLicense ?? "not declared in package.json"}`,
      `included files: ${entry.files.map((file) => file.fileName).join(", ") || "none"}`,
      ...(entry.supplement === undefined
        ? []
        : [
            `text source: ${entry.supplement.sourceUrl}`,
            `supplement note: ${entry.supplement.note}`,
          ]),
      separator(),
      "",
    );

    for (const file of entry.files) {
      lines.push(`--- ${file.fileName} ---`, "", file.text.replace(/\s+$/u, ""), "");
    }
  }

  return lines.join("\n");
}

/** Reads the reviewed supplements, keyed by `name@version`. */
export async function readLicenseSupplements(
  path: string,
): Promise<ReadonlyMap<string, LicenseSupplement>> {
  const supplements = new Map<string, LicenseSupplement>();

  if (!existsSync(path)) {
    return supplements;
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    supplements?: readonly LicenseSupplement[];
  };

  for (const supplement of parsed.supplements ?? []) {
    supplements.set(`${supplement.package}@${supplement.version}`, supplement);
  }

  return supplements;
}

/**
 * Writes `dist/THIRD_PARTY_LICENSES.txt` from the real bundle metadata.
 *
 * The file lands inside `dist/`, which is what `files` publishes, so a tarball
 * without notices is not possible.
 */
export async function writeCliThirdPartyNotices(options: {
  readonly metafile: EsbuildMetafile;
  readonly workingDirectory: string;
  readonly repositoryRoot: string;
  readonly distDirectory: string;
  readonly packageName: string;
  readonly supplementPath: string;
  readonly supplementDirectory: string;
}): Promise<{ readonly path: string; readonly packages: readonly string[] }> {
  const supplements = await readLicenseSupplements(options.supplementPath);
  const entries = await describeBundledPackages(options.metafile, {
    workingDirectory: options.workingDirectory,
    repositoryRoot: options.repositoryRoot,
    supplementDirectory: options.supplementDirectory,
    supplements,
  });

  const target = resolve(options.distDirectory, "THIRD_PARTY_LICENSES.txt");
  await writeFile(
    target,
    renderCliThirdPartyNotices(entries, options.packageName),
    "utf8",
  );

  return {
    path: target,
    packages: entries.map((entry) => `${entry.name}@${entry.version}`),
  };
}

function displayPath(repositoryRoot: string, absolute: string): string {
  const relativePath = relative(repositoryRoot, absolute);

  return isInside(repositoryRoot, absolute)
    ? relativePath.split("\\").join("/")
    : "(outside the repository)";
}

function separator(): string {
  return "-".repeat(78);
}
