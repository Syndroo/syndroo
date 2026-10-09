/**
 * Shared helpers for packing the ten public architecture-v1 packages locally and
 * installing the seven global CLI plugins from the resulting tarballs.
 *
 * Every helper here is pure: the repository directory and the manifest versions
 * are arguments, never read from disk inside this module. `scripts/pack-local.ts`
 * and `scripts/install-local.ts` own the file system and the `npm` invocations,
 * so the rules below can be unit-tested without touching a checkout.
 *
 * Why `installArguments` keeps the `./` prefix: `npm install --global
 * artifacts/syndroo-cli-0.7.0-rc.1.tgz` (no `./`) is parsed as a GitHub
 * `owner/repo` shorthand, and npm runs
 * `git ls-remote ssh://git@github.com/artifacts/...` instead of installing the
 * local tarball. Only a path that starts with `./` (or `/`) is treated as a
 * file, so the prefix is a correctness requirement, not cosmetics.
 *
 * These scripts run through Node's type stripping, so the import specifier keeps
 * the `.ts` extension. `tsconfig.scripts.json` enables
 * `rewriteRelativeImportExtensions` so the compiled `.build/scripts` tree
 * imports the emitted `.js` instead.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { STAGES } from "./v1-stages.ts";

/** Repository-relative directory the pack script writes and install reads. */
export const ARTIFACTS_DIRECTORY = "artifacts";

/**
 * The ten public workspaces: every architecture-v1 stage except the private
 * `@syndroo/core` bundle. Derived from `STAGES` so this list cannot drift from
 * the build and check graphs, and sorted so callers and tests see one order.
 */
export function publicPackageNames(): readonly string[] {
  return STAGES.filter((stage) => stage.corePackage !== true)
    .map((stage) => stage.name)
    .sort();
}

/**
 * The seven packages a global install needs: the CLI and its five official
 * providers, plus the `@syndroo/provider-sdk` contract they build against.
 *
 * `@syndroo/sdk`, `@syndroo/server` and `@syndroo/cloudflare` are a library, a
 * Node server and a Worker bundle - not CLI plugins - so they are deliberately
 * absent. A global install must never pull them in.
 */
export function globalInstallPackageNames(): readonly string[] {
  const names = STAGES.flatMap((stage) =>
    stage.name === "@syndroo/cli" || stage.dir.startsWith("provider-")
      ? [stage.name]
      : [],
  );

  return [...new Set(names)].sort();
}

/** `@syndroo/provider-sdk` + `0.7.0-rc.1` -> `syndroo-provider-sdk-0.7.0-rc.1.tgz`. */
export function tarballName(packageName: string, version: string): string {
  const withoutScope = packageName.startsWith("@")
    ? packageName.slice(1)
    : packageName;

  return `${withoutScope.replaceAll("/", "-")}-${version}.tgz`;
}

/**
 * The exact argv tail passed to `npm install --global`, one `./`-prefixed path
 * per package, for example `./artifacts/syndroo-cli-0.7.0-rc.1.tgz`. The `./`
 * is mandatory (see the module comment): a bare path is read as a GitHub
 * shorthand and fails in `git ls-remote`.
 */
export function installArguments(
  packageNames: readonly string[],
  version: string,
): readonly string[] {
  return packageNames.map(
    (name) => `./${ARTIFACTS_DIRECTORY}/${tarballName(name, version)}`,
  );
}

/**
 * The expected tarballs that are absent from `directory`, in `packageNames`
 * order. The caller turns a non-empty result into one clear "run
 * `npm run pack:local`" message instead of failing mid-install.
 */
export function missingArtifacts(
  directory: string,
  packageNames: readonly string[],
  version: string,
): readonly string[] {
  return packageNames
    .map((name) => tarballName(name, version))
    .filter((fileName) => !existsSync(join(directory, fileName)));
}

/** A manifest's contribution to the single-version rule. */
export type PackageVersion = {
  readonly name: string;
  readonly version: string;
};

/**
 * The one version every packaged manifest must declare. Returns it when the
 * manifests agree and throws, naming the outliers, when they do not, so a
 * release can never be packed from a tree that is only half-bumped.
 */
export function sharedVersion(manifests: readonly PackageVersion[]): string {
  const [first] = manifests;

  if (first === undefined) {
    throw new Error("sharedVersion needs at least one packaged manifest.");
  }

  const outliers = manifests.filter(
    (manifest) => manifest.version !== first.version,
  );

  if (outliers.length > 0) {
    const detail = outliers
      .map((manifest) => `${manifest.name}@${manifest.version}`)
      .join(", ");

    throw new Error(
      `Packaged manifests must share one version (${first.name}@${first.version}); ` +
        `these declare a different version: ${detail}.`,
    );
  }

  return first.version;
}
