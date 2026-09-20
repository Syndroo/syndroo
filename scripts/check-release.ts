import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  classifyVersion,
  type DistTag,
  type ReleaseChannel,
} from "./release-version.js";

const PACKAGE_NAME = "@syndroo/cloudflare-worker";
const PACKAGE_PATH = resolve(
  process.cwd(),
  "packages/cloudflare-worker/package.json",
);
const REPOSITORY_URL = "git+https://github.com/Syndroo/syndroo.git";
const REGISTRY_URL = "https://registry.npmjs.org";

type ReleaseEvent =
  | { readonly kind: "absent" }
  | {
      readonly kind: "release";
      readonly tag: string;
      readonly prerelease: boolean;
    };

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  repository?: {
    url?: string;
  };
};

async function main(): Promise<void> {
  const manifest = parseManifest(await readFile(PACKAGE_PATH, "utf8"));

  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`Expected package name ${PACKAGE_NAME}.`);
  }

  const channel = classifyVersion(manifest.version);

  if (manifest.private === true) {
    throw new Error("Release package must not be private.");
  }

  if (manifest.license !== "Apache-2.0") {
    throw new Error("Release package must use Apache-2.0.");
  }

  if (manifest.repository?.url !== REPOSITORY_URL) {
    throw new Error("Package repository URL does not match Syndroo/syndroo.");
  }

  const release = parseReleaseEvent(process.env);
  assertReleaseMatchesVersion(release, manifest.version, channel);

  const published = await packageVersionExists(manifest.version);

  await writeGithubOutput([
    ["version", manifest.version],
    ["published", String(published)],
    ["dist_tag", channel.distTag],
  ]);

  console.log(
    JSON.stringify({
      package: manifest.name,
      version: manifest.version,
      distTag: channel.distTag,
      releaseTag: release.kind === "release" ? release.tag : null,
      published,
    }),
  );
}

function parseReleaseEvent(env: NodeJS.ProcessEnv): ReleaseEvent {
  const tag = optionalValue(env["SYNDROO_RELEASE_TAG"]);
  const prerelease = optionalValue(env["SYNDROO_RELEASE_PRERELEASE"]);
  const isReleaseEvent = optionalValue(env["GITHUB_EVENT_NAME"]) === "release";

  if (tag === undefined && prerelease === undefined && !isReleaseEvent) {
    return { kind: "absent" };
  }

  if (tag === undefined || prerelease === undefined) {
    throw new Error(
      "SYNDROO_RELEASE_TAG and SYNDROO_RELEASE_PRERELEASE must be set together; a release event must provide both.",
    );
  }

  if (prerelease !== "true" && prerelease !== "false") {
    throw new Error(
      `SYNDROO_RELEASE_PRERELEASE must be "true" or "false", received ${JSON.stringify(prerelease)}.`,
    );
  }

  return { kind: "release", tag, prerelease: prerelease === "true" };
}

function assertReleaseMatchesVersion(
  release: ReleaseEvent,
  version: string,
  channel: ReleaseChannel,
): void {
  if (release.kind === "absent") {
    return;
  }

  if (release.tag !== `v${version}`) {
    throw new Error(
      `Release tag ${JSON.stringify(release.tag)} does not match package version ${version}.`,
    );
  }

  if (release.prerelease !== channel.prerelease) {
    throw new Error(
      channel.prerelease
        ? `Release candidate ${version} must be published as a GitHub prerelease.`
        : `Stable version ${version} must be published as a non-prerelease GitHub release.`,
    );
  }
}

async function packageVersionExists(version: string): Promise<boolean> {
  if (process.env.SYNDROO_CHECK_REGISTRY !== "true") {
    return false;
  }

  const response = await fetchRegistry(version);

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(
      `npm registry check failed with HTTP ${String(response.status)}; refusing to publish.`,
    );
  }

  if (response.body !== null) {
    await response.body.cancel();
  }

  return true;
}

async function fetchRegistry(version: string): Promise<Response> {
  const url = `${REGISTRY_URL}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`;

  try {
    return await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(
      `npm registry check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function parseManifest(json: string): PackageManifest {
  const value: unknown = JSON.parse(json);

  if (!isRecord(value)) {
    throw new Error("Package manifest must be an object.");
  }

  const repository = isRecord(value.repository)
    ? {
        ...(typeof value.repository.url === "string"
          ? { url: value.repository.url }
          : {}),
      }
    : undefined;

  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("Package manifest must include name and version.");
  }

  return {
    name: value.name,
    version: value.version,
    ...(typeof value.private === "boolean" ? { private: value.private } : {}),
    ...(typeof value.license === "string" ? { license: value.license } : {}),
    ...(repository !== undefined ? { repository } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await main();
