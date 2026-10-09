import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  globalInstallPackageNames,
  installArguments,
  missingArtifacts,
  publicPackageNames,
  sharedVersion,
  tarballName,
} from "./lib/local-release.js";

/**
 * The local release loop packs ten public packages and installs seven of them
 * globally. These tests pin the exact membership of both sets and the exact
 * shape of the install arguments, because three real failures motivated the
 * scripts: a bare `artifacts/...` path read by npm as a GitHub shorthand, an
 * install that pulls in the private `@syndroo/core`, and a `npm pack --workspaces`
 * run that shipped a `syndroo-core-*.tgz` that must never exist.
 */

const VERSION = "0.7.0-rc.1";

/** The ten public workspaces, sorted. `@syndroo/core` is deliberately absent. */
const PUBLIC_PACKAGES = [
  "@syndroo/cli",
  "@syndroo/cloudflare",
  "@syndroo/provider-bluesky",
  "@syndroo/provider-devto",
  "@syndroo/provider-linkedin",
  "@syndroo/provider-mastodon",
  "@syndroo/provider-sdk",
  "@syndroo/provider-threads",
  "@syndroo/sdk",
  "@syndroo/server",
] as const;

/** The seven packages a global install needs: the CLI plugins, not libraries. */
const INSTALL_PACKAGES = [
  "@syndroo/cli",
  "@syndroo/provider-bluesky",
  "@syndroo/provider-devto",
  "@syndroo/provider-linkedin",
  "@syndroo/provider-mastodon",
  "@syndroo/provider-sdk",
  "@syndroo/provider-threads",
] as const;

describe("public workspace list", () => {
  it("is exactly the ten public packages and never the private Core package", () => {
    assert.deepEqual(publicPackageNames(), [...PUBLIC_PACKAGES]);
    assert.equal(publicPackageNames().includes("@syndroo/core"), false);
  });
});

describe("global install set", () => {
  it("is exactly the seven CLI plugins and excludes the libraries", () => {
    assert.deepEqual(globalInstallPackageNames(), [...INSTALL_PACKAGES]);

    for (const library of ["@syndroo/sdk", "@syndroo/server", "@syndroo/cloudflare"]) {
      assert.equal(
        globalInstallPackageNames().includes(library),
        false,
        `${library} is not a CLI plugin and must not be installed globally`,
      );
    }
  });
});

describe("install arguments", () => {
  it("prefixes every argument with ./ so npm never reads a bare owner/repo shorthand", () => {
    // npm parses a bare `artifacts/syndroo-cli-0.7.0-rc.1.tgz` (no `./`) as the
    // GitHub shorthand `owner/repo`, and runs `git ls-remote
    // ssh://git@github.com/artifacts/...` instead of installing the local file.
    // Dropping the `./` is a failure, not a formatting nit.
    const args = installArguments(globalInstallPackageNames(), VERSION);

    assert.equal(args.length, INSTALL_PACKAGES.length);
    for (const arg of args) {
      assert.ok(
        arg.startsWith("./artifacts/"),
        `${arg} must start with ./artifacts/`,
      );
    }

    assert.deepEqual(args, [
      "./artifacts/syndroo-cli-0.7.0-rc.1.tgz",
      "./artifacts/syndroo-provider-bluesky-0.7.0-rc.1.tgz",
      "./artifacts/syndroo-provider-devto-0.7.0-rc.1.tgz",
      "./artifacts/syndroo-provider-linkedin-0.7.0-rc.1.tgz",
      "./artifacts/syndroo-provider-mastodon-0.7.0-rc.1.tgz",
      "./artifacts/syndroo-provider-sdk-0.7.0-rc.1.tgz",
      "./artifacts/syndroo-provider-threads-0.7.0-rc.1.tgz",
    ]);
  });
});

describe("tarball names", () => {
  it("strips the scope for a scoped package", () => {
    assert.equal(
      tarballName("@syndroo/provider-sdk", VERSION),
      "syndroo-provider-sdk-0.7.0-rc.1.tgz",
    );
  });

  it("leaves an unscoped package name alone", () => {
    assert.equal(tarballName("foo", "1.2.3"), "foo-1.2.3.tgz");
  });
});

const FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "syndroo-local-release-"));

after(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("missing artifacts", () => {
  it("reports exactly the absent tarball", async () => {
    const directory = await mkdtemp(join(FIXTURE_ROOT, "missing-"));
    const packages = ["@syndroo/cli", "@syndroo/provider-sdk"];

    await writeFile(join(directory, tarballName("@syndroo/cli", VERSION)), "");

    assert.deepEqual(missingArtifacts(directory, packages, VERSION), [
      tarballName("@syndroo/provider-sdk", VERSION),
    ]);
  });

  it("reports nothing when every expected tarball exists", async () => {
    const directory = await mkdtemp(join(FIXTURE_ROOT, "complete-"));
    const packages = ["@syndroo/cli", "@syndroo/provider-sdk"];

    for (const name of packages) {
      await writeFile(join(directory, tarballName(name, VERSION)), "");
    }

    assert.deepEqual(missingArtifacts(directory, packages, VERSION), []);
  });
});

describe("single-version rule", () => {
  it("returns the shared version when every manifest agrees", () => {
    assert.equal(
      sharedVersion([
        { name: "@syndroo/cli", version: VERSION },
        { name: "@syndroo/provider-sdk", version: VERSION },
      ]),
      VERSION,
    );
  });

  it("rejects a manifest that declares a different version, naming it", () => {
    assert.throws(
      () =>
        sharedVersion([
          { name: "@syndroo/cli", version: VERSION },
          { name: "@syndroo/sdk", version: "0.7.0" },
        ]),
      /must share one version.*@syndroo\/sdk@0\.7\.0/u,
    );
  });
});
