#!/usr/bin/env node
/**
 * Validates the whole v0.4.0 release train, not one package.
 *
 * The release is three public packages that must agree on one version and one
 * dist-tag, must be published in dependency order, and cannot be published
 * atomically. This checker answers one question before any publish step runs:
 * is this checkout a complete, internally consistent release train, and which
 * of its packages still have to be published?
 *
 * Hard rules enforced here:
 *
 * 1. A `-rc.<n>` version publishes under `next`. The dist-tag is derived from
 *    the version, and a publish step that asks for a different tag is refused,
 *    so an RC cannot be retagged as `latest` and announced as a stable release.
 * 2. A published version is never republished. An existing version is reported
 *    as already published and skipped; npm cannot overwrite it anyway.
 *
 * Only HTTP 404 counts as "not published". Any other registry answer, including
 * 401/403/5xx and a transport failure, fails closed instead of being read as an
 * unpublished version.
 */

import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRepositoryRoot } from "./package-support.js";
import {
  classifyVersion,
  releaseStage,
  versionShapeError,
  type DistTag,
  type ReleaseChannel,
} from "./release-version.js";

export type TrainPackage = {
  /** Public npm name. */
  readonly name: string;
  /** Repository-relative directory that holds the public manifest. */
  readonly directory: string;
  /** GitHub-output and log label; stable so the workflow can branch on it. */
  readonly slug: string;
  /** Entries the manifest `files` array must include. */
  readonly requiredFiles: readonly string[];
  /** Required `bin` entries, mapped to their target path. */
  readonly requiredBins: Readonly<Record<string, string>>;
  /** Package that must be published before this one, if any. */
  readonly dependsOn?: string;
};

/**
 * The publish order is the array order: the CLI cannot install without the SDK,
 * and the Worker is the deployable artifact that ships last.
 */
export const RELEASE_TRAIN: readonly TrainPackage[] = [
  {
    name: "@syndroo/sdk",
    directory: "packages/sdk",
    slug: "sdk",
    requiredFiles: ["dist", "LICENSE", "NOTICE", "README.md"],
    requiredBins: {},
  },
  {
    name: "@syndroo/cli",
    directory: "packages/cli",
    slug: "cli",
    requiredFiles: ["dist", "skills", "LICENSE", "NOTICE", "README.md"],
    requiredBins: { syndroo: "./dist/bin.js" },
    dependsOn: "@syndroo/sdk",
  },
  {
    name: "@syndroo/cloudflare-worker",
    directory: "packages/cloudflare-worker",
    slug: "worker",
    requiredFiles: [
      "dist",
      "licenses",
      "migrations",
      "types",
      "LICENSE",
      "NOTICE",
      "README.md",
    ],
    requiredBins: { "syndroo-deploy": "./dist/deploy.js" },
  },
];

export const REPOSITORY_URL = "git+https://github.com/Syndroo/syndroo.git";
export const REGISTRY_URL = "https://registry.npmjs.org";
export const REQUIRED_LICENSE = "Apache-2.0";
export const REQUIRED_NODE_ENGINE = ">=22";

/**
 * Which packages this run is allowed to publish.
 *
 * `all` is the historical train: one uniform version, and a CLI that installs
 * the exact SDK it was built against. `cli` is the 0.6 candidate: the CLI ships
 * self-contained, so it is validated on its own and must carry no runtime
 * dependency on any workspace package. Selecting `all` never stops being a
 * meaningful check; `cli` narrows the set instead of relaxing a rule.
 */
export type ReleaseSet = "all" | "cli";

export const DEFAULT_RELEASE_SET: ReleaseSet = "all";

export function parseReleaseSet(env: NodeJS.ProcessEnv): ReleaseSet {
  const raw = optionalValue(env["SYNDROO_RELEASE_SET"]);

  if (raw === undefined || raw === "all") {
    return "all";
  }

  if (raw === "cli") {
    return "cli";
  }

  throw new Error(
    `SYNDROO_RELEASE_SET must be "all" or "cli", received ${JSON.stringify(raw)}.`,
  );
}

/** The packages a release set is responsible for. */
export function releaseSetPackages(
  releaseSet: ReleaseSet,
): readonly TrainPackage[] {
  if (releaseSet === "all") {
    return RELEASE_TRAIN;
  }

  return RELEASE_TRAIN.filter((definition) => definition.name === "@syndroo/cli");
}

export type PackageStatus = "publish" | "already-published" | "blocked";

export type PackagePlan = {
  readonly name: string;
  readonly slug: string;
  readonly version: string;
  readonly distTag: DistTag;
  readonly status: PackageStatus;
  readonly detail: string;
};

type ReleaseEvent =
  | { readonly kind: "absent" }
  | { readonly kind: "release"; readonly tag: string; readonly prerelease: boolean };

export type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly files?: readonly string[];
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly publishConfig?: Readonly<Record<string, string>>;
  readonly repository?: { readonly url?: string; readonly directory?: string };
};

export type RegistryProbe =
  | { readonly kind: "absent" }
  | {
      readonly kind: "published";
      /** Value of the `latest` dist-tag in the packument, when present. */
      readonly latest: string | undefined;
    }
  | {
      readonly kind: "error";
      readonly detail: string;
    };

export type TrainResult = {
  readonly ok: boolean;
  readonly releaseSet: ReleaseSet;
  readonly stage: string | null;
  readonly version: string | null;
  readonly distTag: DistTag | null;
  readonly registryChecked: boolean;
  readonly packages: readonly PackagePlan[];
  readonly publishRequired: boolean;
  readonly failures: readonly string[];
};

const TRAIN_NAMES: ReadonlySet<string> = new Set(
  RELEASE_TRAIN.map((definition) => definition.name),
);

const failures: string[] = [];

function fail(detail: string): void {
  failures.push(detail);
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const root = resolveRepositoryRoot(process.cwd());
  const manifests: Manifest[] = [];
  let releaseSet: ReleaseSet;

  try {
    releaseSet = parseReleaseSet(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    finish(failed(DEFAULT_RELEASE_SET));
    return;
  }

  const selected = releaseSetPackages(releaseSet);

  for (const definition of selected) {
    const path = resolve(root, definition.directory, "package.json");
    let parsed: Manifest;

    try {
      parsed = parseManifest(await readFile(path, "utf8"));
    } catch (error) {
      // A missing or unreadable manifest makes every later comparison
      // meaningless, so it ends the run with that one clear reason.
      fail(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
      finish(failed(releaseSet));
      return;
    }

    manifests.push(parsed);
    checkManifest(definition, parsed, manifests, releaseSet);
  }

  const declared = manifests[0]?.version;
  let channel: ReleaseChannel | undefined;

  try {
    channel = classifyVersion(declared as string);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (declared !== undefined) {
    const release = parseReleaseEvent(process.env);

    if (channel !== undefined) {
      checkReleaseEvent(release, declared, channel.prerelease);
      checkDistTagExpectation(arguments_.distTag, channel.distTag, declared);
    }
  }

  if (failures.length > 0 || channel === undefined || declared === undefined) {
    finish(failed(releaseSet));
    return;
  }

  const registryChecked = process.env["SYNDROO_CHECK_REGISTRY"] === "true";
  const packages = registryChecked
    ? await planWithRegistry(
        declared,
        channel.distTag,
        channel.prerelease,
        selected,
      )
    : planWithoutRegistry(declared, channel.distTag, selected);

  const publishRequired = packages.some((entry) => entry.status === "publish");
  const ok = failures.length === 0;

  if (ok) {
    writeGithubOutput([
      ["release_set", releaseSet],
      ["version", declared],
      ["stage", releaseStage(channel)],
      ["dist_tag", channel.distTag],
      ["publish_required", String(publishRequired)],
      ...selected.map(
        (definition) =>
          [
            `${definition.slug}_status`,
            statusOf(packages, definition.name),
          ] as const,
      ),
      ...selected.map(
        (definition) =>
          [
            `publish_${definition.slug}`,
            String(statusOf(packages, definition.name) === "publish"),
          ] as const,
      ),
    ]);
  }

  finish({
    ok,
    releaseSet,
    stage: releaseStage(channel),
    version: declared,
    distTag: channel.distTag,
    registryChecked,
    packages,
    publishRequired,
    failures,
  });
}

function statusOf(packages: readonly PackagePlan[], name: string): string {
  return packages.find((entry) => entry.name === name)?.status ?? "blocked";
}

/**
 * Recovery guidance for a partly published train. The three publications are
 * not atomic, so the only safe continuation is to publish exactly the packages
 * that are still missing and then re-check; an already published version is
 * skipped and never overwritten.
 */
function nextStep(result: TrainResult): { readonly nextStep: string } {
  if (!result.ok) {
    return { nextStep: "Fix the reported failures, then run this check again." };
  }

  const pending = result.packages.filter((entry) => entry.status === "publish");
  const published = result.packages.filter(
    (entry) => entry.status === "already-published",
  );

  if (pending.length === 0) {
    return {
      nextStep: `All ${String(result.packages.length)} package(s) in the ${result.releaseSet} release set already exist at ${String(result.version)}; nothing to publish.`,
    };
  }

  const names = pending.map((entry) => entry.name).join(" -> ");
  const recovery =
    published.length === 0
      ? ""
      : ` ${String(published.length)} package(s) already exist and must not be republished.`;

  return {
    nextStep: `Publish only ${names} under ${String(result.distTag)}, then run this check again.${recovery}`,
  };
}

/** Every run ends here, so a failing check still reports machine-readable facts. */
function finish(result: TrainResult): void {
  for (const message of result.failures) {
    process.stderr.write(`release-train: ${message}\n`);
  }

  console.log(JSON.stringify({ ...result, ...nextStep(result) }, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

/** A run that stopped before it could resolve the train. */
function failed(releaseSet: ReleaseSet): TrainResult {
  return {
    ok: false,
    releaseSet,
    stage: null,
    version: null,
    distTag: null,
    registryChecked: false,
    packages: [],
    publishRequired: false,
    failures,
  };
}

function checkManifest(
  definition: TrainPackage,
  manifest: Manifest,
  collected: readonly Manifest[],
  releaseSet: ReleaseSet,
): void {
  if (manifest.name !== definition.name) {
    fail(
      `${definition.directory}: expected package name ${definition.name}, found ${JSON.stringify(manifest.name)}.`,
    );
    return;
  }

  if (collected.length === 1) {
    // The first package pins the train version; every later package is
    // compared against it.
    if (!/^\d/.test(manifest.version)) {
      fail(`${definition.name}: ${versionShapeError(manifest.version)}`);
      return;
    }

    try {
      classifyVersion(manifest.version);
    } catch (error) {
      fail(`${definition.name}: ${(error as Error).message}`);
      return;
    }
  } else {
    const expected = collected[0]?.version;
    if (manifest.version !== expected) {
      fail(
        `${definition.name} declares version ${JSON.stringify(manifest.version)} but the train version is ${JSON.stringify(expected)}. All three packages must ship the same version.`,
      );
    }
  }

  if (manifest.private === true) {
    fail(`${definition.name} must not be private; it is a published release package.`);
  }

  if (manifest.license !== REQUIRED_LICENSE) {
    fail(`${definition.name} must use ${REQUIRED_LICENSE}.`);
  }

  if (manifest.repository?.url !== REPOSITORY_URL) {
    fail(`${definition.name} repository URL does not match Syndroo/syndroo.`);
  }

  if (manifest.repository?.directory !== definition.directory) {
    fail(
      `${definition.name} repository directory must be ${definition.directory}, found ${JSON.stringify(manifest.repository?.directory)}.`,
    );
  }

  if (manifest.publishConfig?.["access"] !== "public") {
    fail(`${definition.name} publishConfig.access must be "public".`);
  }

  if (manifest.engines?.["node"] !== REQUIRED_NODE_ENGINE) {
    fail(
      `${definition.name} engines.node must be ${JSON.stringify(REQUIRED_NODE_ENGINE)}.`,
    );
  }

  for (const required of definition.requiredFiles) {
    if (!manifest.files?.includes(required)) {
      fail(`${definition.name} "files" must include ${JSON.stringify(required)}.`);
    }
  }

  for (const [bin, target] of Object.entries(definition.requiredBins)) {
    if (manifest.bin?.[bin] !== target) {
      fail(`${definition.name} bin ${bin} must point at ${target}.`);
    }
  }

  for (const field of ["dependencies", "devDependencies"] as const) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) {
        fail(`${definition.name} ${field}.${name} uses the workspace protocol.`);
      }

      if (
        field === "dependencies" &&
        name.startsWith("@syndroo/") &&
        !TRAIN_NAMES.has(name)
      ) {
        fail(
          `${definition.name} must not depend on the private workspace package ${name} at runtime.`,
        );
      }
    }
  }

  // A self-contained release set publishes the CLI alone, so the CLI must carry
  // no runtime dependency on a workspace package at all. The historical train
  // keeps its exact-version pin.
  if (releaseSet === "cli") {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith("@syndroo/")) {
        fail(
          `${definition.name} must be self-contained; it must not depend on ${name} at runtime.`,
        );
      }
    }
  }

  if (definition.dependsOn !== undefined && releaseSet === "all") {
    const range = manifest.dependencies?.[definition.dependsOn];

    if (range !== manifest.version) {
      fail(
        `${definition.name} must depend on exactly ${definition.dependsOn}@${manifest.version}; found ${JSON.stringify(range)}. A range would let a published CLI install a different SDK than the one in this train.`,
      );
    }
  }
}

function parseReleaseEvent(env: NodeJS.ProcessEnv): ReleaseEvent {
  const tag = optionalValue(env["SYNDROO_RELEASE_TAG"]);
  const prerelease = optionalValue(env["SYNDROO_RELEASE_PRERELEASE"]);
  const isReleaseEvent = optionalValue(env["GITHUB_EVENT_NAME"]) === "release";

  if (tag === undefined && prerelease === undefined && !isReleaseEvent) {
    return { kind: "absent" };
  }

  if (tag === undefined || prerelease === undefined) {
    fail(
      "SYNDROO_RELEASE_TAG and SYNDROO_RELEASE_PRERELEASE must be set together; a release event must provide both.",
    );
    return { kind: "absent" };
  }

  if (prerelease !== "true" && prerelease !== "false") {
    fail(
      `SYNDROO_RELEASE_PRERELEASE must be "true" or "false", received ${JSON.stringify(prerelease)}.`,
    );
    return { kind: "absent" };
  }

  return { kind: "release", tag, prerelease: prerelease === "true" };
}

function checkReleaseEvent(
  release: ReleaseEvent,
  version: string,
  prerelease: boolean,
): void {
  if (release.kind === "absent") {
    return;
  }

  if (release.tag !== `v${version}`) {
    fail(
      `Release tag ${JSON.stringify(release.tag)} does not match the train version ${version}.`,
    );
  }

  if (release.prerelease !== prerelease) {
    fail(
      prerelease
        ? `Release candidate ${version} must be published as a GitHub prerelease.`
        : `Stable version ${version} must be published as a non-prerelease GitHub release.`,
    );
  }
}

/**
 * The publish step hands back the dist-tag it is about to use. It must be the
 * tag the version implies: no input can move a candidate onto `latest`.
 */
function checkDistTagExpectation(
  requested: string | undefined,
  expected: DistTag,
  version: string,
): void {
  if (requested === undefined) {
    return;
  }

  if (requested !== expected) {
    fail(
      `Refusing to publish version ${version} under dist-tag ${JSON.stringify(requested)}; this version must publish under ${expected}. A release candidate cannot be retagged as a stable release.`,
    );
  }
}

function planWithoutRegistry(
  version: string,
  distTag: DistTag,
  selected: readonly TrainPackage[],
): readonly PackagePlan[] {
  return selected.map((definition) => ({
    name: definition.name,
    slug: definition.slug,
    version,
    distTag,
    status: "publish",
    detail: "registry not checked (SYNDROO_CHECK_REGISTRY is not true)",
  }));
}

async function planWithRegistry(
  version: string,
  distTag: DistTag,
  prerelease: boolean,
  selected: readonly TrainPackage[],
): Promise<readonly PackagePlan[]> {
  const packages: PackagePlan[] = [];
  const published: string[] = [];
  let blocked = false;

  for (const definition of selected) {
    if (blocked) {
      packages.push({
        name: definition.name,
        slug: definition.slug,
        version,
        distTag,
        status: "blocked",
        detail: "not attempted; an earlier registry check or package in the train failed",
      });
      continue;
    }

    const probe = await probeRegistry(definition.name, version);

    if (probe.kind === "error") {
      fail(
        `${definition.name}: npm registry check failed (${probe.detail}); refusing to publish.`,
      );
      blocked = true;
      packages.push({
        name: definition.name,
        slug: definition.slug,
        version,
        distTag,
        status: "blocked",
        detail: probe.detail,
      });
      continue;
    }

    if (probe.kind === "absent") {
      packages.push({
        name: definition.name,
        slug: definition.slug,
        version,
        distTag,
        status: "publish",
        detail: `${definition.name}@${version} is not published (HTTP 404)`,
      });
      continue;
    }

    checkPublishedTags(definition.name, version, distTag, prerelease, probe);
    published.push(definition.name);
    packages.push({
      name: definition.name,
      slug: definition.slug,
      version,
      distTag,
      status: "already-published",
      detail: `${definition.name}@${version} already exists and will not be republished`,
    });
  }

  // The train publishes in order. Seeing a later package already published
  // while an earlier one is missing means the state on npm is not the state
  // this train describes, so the run stops instead of guessing.
  const firstPending = packages.findIndex((entry) => entry.status === "publish");
  const outOfOrder = packages.find(
    (entry, index) => index > firstPending && entry.status === "already-published",
  );

  if (firstPending >= 0 && outOfOrder !== undefined) {
    const pending = packages[firstPending] as PackagePlan;
    fail(
      `Publish order violated: ${outOfOrder.name} is already published but ${pending.name} is not. Publish ${pending.name} first, or confirm the registry state before continuing.`,
    );
  }

  if (packages.length > 0 && failures.length === 0 && published.length > 0) {
    // Existing versions are skipped, never overwritten; record the recovery
    // decision in the log so an operator does not have to infer it.
    process.stderr.write(
      `release-train: already published, skipping: ${published.join(", ")}\n`,
    );
  }

  return packages;
}

function checkPublishedTags(
  name: string,
  version: string,
  distTag: DistTag,
  prerelease: boolean,
  probe: Extract<RegistryProbe, { kind: "published" }>,
): void {
  if (prerelease) {
    if (probe.latest === version) {
      fail(
        `${name}@${version} is a release candidate but is already the \`latest\` dist-tag. An RC must never be installed by default; investigate before continuing.`,
      );
    }

    return;
  }

  if (probe.latest !== version) {
    fail(
      `The \`latest\` dist-tag for ${name} points at ${JSON.stringify(probe.latest)}, not ${version}. A stable release must end up on \`latest\`; trying to retag a candidate does not change a published version.`,
    );
  }

  if (distTag !== "latest") {
    fail(`${name} is a stable version but the train resolved dist-tag ${distTag}.`);
  }
}

/**
 * One packument request per package. The packument carries both the version
 * list and the dist-tags, so existence and tag placement are decided from a
 * single answer.
 */
async function probeRegistry(
  name: string,
  version: string,
): Promise<RegistryProbe> {
  const url = `${REGISTRY_URL}/${encodeURIComponent(name)}`;
  let response: Response;

  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    return {
      kind: "error",
      detail: `network failure: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 404) {
    return { kind: "absent" };
  }

  if (!response.ok) {
    return { kind: "error", detail: `HTTP ${String(response.status)}` };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    return {
      kind: "error",
      detail: `unreadable packument: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRecord(body)) {
    return { kind: "error", detail: "packument is not a JSON object" };
  }

  const versions = isRecord(body["versions"]) ? body["versions"] : {};
  const tags = isRecord(body["dist-tags"]) ? body["dist-tags"] : {};

  if (!Object.hasOwn(versions, version)) {
    return { kind: "absent" };
  }

  return {
    kind: "published",
    latest: typeof tags["latest"] === "string" ? tags["latest"] : undefined,
  };
}

type Arguments = {
  readonly distTag: string | undefined;
};

function parseArguments(argv: readonly string[]): Arguments {
  let distTag = optionalValue(process.env["SYNDROO_DIST_TAG"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--json") {
      continue;
    }

    if (token === "--expect-dist-tag" || token === "--dist-tag") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error(`${token} requires a value.`);
      }

      distTag = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--expect-dist-tag=")) {
      distTag = token.slice("--expect-dist-tag=".length);
      continue;
    }

    throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
  }

  return { distTag };
}

async function writeGithubOutput(
  outputs: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const outputPath = optionalValue(process.env["GITHUB_OUTPUT"]);

  if (outputPath === undefined) {
    return;
  }

  const lines = outputs.map(([key, value]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error(`Refusing to write unsafe output name ${JSON.stringify(key)}.`);
    }

    if (/[\r\n]/.test(value)) {
      throw new Error(`Refusing to write unsafe output value for ${key}.`);
    }

    return `${key}=${value}`;
  });

  await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function optionalValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}

export function parseManifest(json: string): Manifest {
  const value: unknown = JSON.parse(json);

  if (!isRecord(value)) {
    throw new Error("Package manifest must be an object.");
  }

  if (typeof value["name"] !== "string" || typeof value["version"] !== "string") {
    throw new Error("Package manifest must include name and version.");
  }

  const files = stringArray(value["files"]);
  const bin = stringRecord(value["bin"]);
  const dependencies = stringRecord(value["dependencies"]);
  const devDependencies = stringRecord(value["devDependencies"]);
  const engines = stringRecord(value["engines"]);
  const publishConfig = stringRecord(value["publishConfig"]);
  const repository = isRecord(value["repository"])
    ? {
        ...(typeof value["repository"]["url"] === "string"
          ? { url: value["repository"]["url"] }
          : {}),
        ...(typeof value["repository"]["directory"] === "string"
          ? { directory: value["repository"]["directory"] }
          : {}),
      }
    : undefined;

  return {
    name: value["name"],
    version: value["version"],
    ...(typeof value["private"] === "boolean" ? { private: value["private"] } : {}),
    ...(typeof value["license"] === "string" ? { license: value["license"] } : {}),
    ...(files === undefined ? {} : { files }),
    ...(bin === undefined ? {} : { bin }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(engines === undefined ? {} : { engines }),
    ...(publishConfig === undefined ? {} : { publishConfig }),
    ...(repository === undefined ? {} : { repository }),
  };
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
    ? value
    : undefined;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Importing this module from a test must not run the checker or talk to the
// network; only a direct invocation does.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    finish(failed(DEFAULT_RELEASE_SET));
  }
}
