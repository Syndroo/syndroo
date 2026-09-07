import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PACKAGE_NAME = "@syndroo/cloudflare-worker";
const PACKAGE_PATH = resolve(
  process.cwd(),
  "packages/cloudflare-worker/package.json",
);
const STABLE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

  if (!STABLE_SEMVER.test(manifest.version)) {
    throw new Error("Package version must be a stable SemVer version.");
  }

  if (manifest.private === true) {
    throw new Error("Release package must not be private.");
  }

  if (manifest.license !== "Apache-2.0") {
    throw new Error("Release package must use Apache-2.0.");
  }

  if (
    manifest.repository?.url !==
    "git+https://github.com/Syndroo/syndroo.git"
  ) {
    throw new Error("Package repository URL does not match Syndroo/syndroo.");
  }

  const releaseTag = process.env.SYNDROO_RELEASE_TAG || undefined;

  if (process.env.SYNDROO_RELEASE_PRERELEASE === "true") {
    throw new Error("Prerelease GitHub releases cannot publish the stable package.");
  }

  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    throw new Error(
      `Release tag ${releaseTag} does not match package version ${manifest.version}.`,
    );
  }

  const published = await packageVersionExists(manifest.version);
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath !== undefined) {
    await appendFile(
      outputPath,
      `version=${manifest.version}\npublished=${String(published)}\n`,
      "utf8",
    );
  }

  console.log(
    JSON.stringify({
      package: manifest.name,
      version: manifest.version,
      releaseTag,
      published,
    }),
  );
}

async function packageVersionExists(version: string): Promise<boolean> {
  if (process.env.SYNDROO_CHECK_REGISTRY !== "true") {
    return false;
  }

  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${version}`,
    {
      headers: {
        accept: "application/json",
      },
    },
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(
      `npm registry check failed with HTTP ${String(response.status)}.`,
    );
  }

  if (response.body !== null) {
    await response.body.cancel();
  }

  return true;
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
