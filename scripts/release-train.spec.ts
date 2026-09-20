import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_URL = "git+https://github.com/Syndroo/syndroo.git";
const CHECKER_PATH = fileURLToPath(new URL("./release-train.js", import.meta.url));
const FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "syndroo-release-train-"));

assert.ok(
  existsSync(CHECKER_PATH),
  `Compiled checker missing at ${CHECKER_PATH}. Run \`npm run build:scripts\` first.`,
);

/**
 * Replaces global fetch for one checker run. The packument the checker reads is
 * built from a per-package state file, so a fixture can describe an unpublished
 * package, an HTTP failure, or an exact set of published versions and dist-tags
 * without any network access.
 */
const FAKE_REGISTRY_MODULE = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  "",
  "const statePath = process.env.FAKE_REGISTRY_STATE;",
  "const logPath = process.env.FAKE_REGISTRY_LOG;",
  "",
  "function state() {",
  '  return statePath === undefined || statePath.length === 0 ? {} : JSON.parse(readFileSync(statePath, "utf8"));',
  "}",
  "",
  "function packageName(url) {",
  '  const pathname = new URL(String(url)).pathname.replace(/^\\//u, "");',
  "  return decodeURIComponent(pathname);",
  "}",
  "",
  "globalThis.fetch = async (url) => {",
  "  if (logPath !== undefined && logPath.length > 0) {",
  '    appendFileSync(logPath, String(url) + "\\n");',
  "  }",
  "",
  '  const entry = state()[packageName(url)] ?? { mode: "absent" };',
  "",
  '  if (entry.mode === "network-error") {',
  '    throw new TypeError("simulated registry network failure");',
  "  }",
  "",
  '  if (entry.mode === "http") {',
  "    return new Response(null, { status: Number(entry.status) });",
  "  }",
  "",
  '  if (entry.mode === "absent") {',
  "    return new Response(null, { status: 404 });",
  "  }",
  "",
  '  if (entry.mode === "unreadable") {',
  '    return new Response("not json", {',
  "      status: 200,",
  '      headers: { "content-type": "application/json" },',
  "    });",
  "  }",
  "",
  "  const versions = Object.fromEntries(",
  '    (entry.versions ?? []).map((v) => [v, { version: v }]),',
  "  );",
  "",
  "  return new Response(",
  '    JSON.stringify({ versions, "dist-tags": entry.tags ?? {} }),',
  "    {",
  "      status: 200,",
  '      headers: { "content-type": "application/json" },',
  "    },",
  "  );",
  "};",
  "",
].join("\n");

const BASE_MANIFESTS: Readonly<Record<string, Record<string, unknown>>> = {
  sdk: {
    name: "@syndroo/sdk",
    directory: "packages/sdk",
    files: ["dist", "LICENSE", "NOTICE", "README.md"],
  },
  cli: {
    name: "@syndroo/cli",
    directory: "packages/cli",
    files: ["dist", "skills", "LICENSE", "NOTICE", "README.md"],
    bin: { syndroo: "./dist/bin.js" },
    dependsOn: "@syndroo/sdk",
  },
  worker: {
    name: "@syndroo/cloudflare-worker",
    directory: "packages/cloudflare-worker",
    files: [
      "dist",
      "licenses",
      "migrations",
      "types",
      "LICENSE",
      "NOTICE",
      "README.md",
    ],
    bin: { "syndroo-deploy": "./dist/deploy.js" },
  },
};

type PackageKey = keyof typeof BASE_MANIFESTS;
type Overrides = Partial<Record<PackageKey, Record<string, unknown>>>;

type Fixture = {
  readonly dir: string;
  readonly outputPath: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly preloadPath: string;
};

type RunOptions = {
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  readonly preload?: boolean;
  readonly output?: boolean;
};

type CheckerRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown>;
};

async function createFixture(
  name: string,
  options: {
    readonly version?: string;
    readonly overrides?: Overrides;
    readonly remove?: readonly PackageKey[];
  } = {},
): Promise<Fixture> {
  const dir = join(FIXTURE_ROOT, name);
  const version = options.version ?? "0.4.0-rc.1";

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "syndroo", private: true, version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(dir, "wrangler.jsonc"), "{}\n", "utf8");

  for (const [key, base] of Object.entries(BASE_MANIFESTS)) {
    if (options.remove?.includes(key as PackageKey) === true) {
      continue;
    }

    const manifest: Record<string, unknown> = {
      version,
      license: "Apache-2.0",
      repository: { type: "git", url: REPOSITORY_URL, directory: base["directory"] },
      engines: { node: ">=22" },
      publishConfig: { access: "public" },
      ...base,
      ...(options.overrides?.[key as PackageKey] ?? {}),
    };

    if (typeof manifest["dependsOn"] === "string") {
      const dependency = manifest["dependsOn"];
      const explicit = manifest["dependencies"] as Record<string, string> | undefined;
      delete manifest["dependsOn"];
      manifest["dependencies"] = {
        [dependency]: manifest["version"],
        ...explicit,
      };
    }

    const packageDirectory = join(dir, base["directory"] as string);
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  const statePath = join(dir, "registry-state.json");
  const preloadPath = join(dir, "fake-registry.mjs");
  await writeFile(statePath, "{}\n", "utf8");
  await writeFile(preloadPath, FAKE_REGISTRY_MODULE, "utf8");

  return {
    dir,
    outputPath: join(dir, "github-output.txt"),
    statePath,
    logPath: join(dir, "registry-requests.log"),
    preloadPath,
  };
}

async function setRegistryState(
  fixture: Fixture,
  state: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function runChecker(fixture: Fixture, options: RunOptions = {}): CheckerRun {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...options.env,
  };

  if (options.output !== false) {
    env["GITHUB_OUTPUT"] = fixture.outputPath;
  }

  if (options.preload === true) {
    env["FAKE_REGISTRY_STATE"] = fixture.statePath;
    env["FAKE_REGISTRY_LOG"] = fixture.logPath;
  }

  const checkerArguments = [CHECKER_PATH, ...(options.args ?? [])];
  const args =
    options.preload === true
      ? ["--import", pathToFileURL(fixture.preloadPath).href, ...checkerArguments]
      : checkerArguments;

  const result = spawnSync(process.execPath, args, {
    cwd: fixture.dir,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(
    result.error,
    undefined,
    `Failed to start the checker: ${String(result.error)}`,
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: JSON.parse(result.stdout) as Record<string, unknown>,
  };
}

async function readOutputs(fixture: Fixture): Promise<Record<string, string>> {
  const raw = await readFile(fixture.outputPath, "utf8");
  const entries: Array<[string, string]> = [];

  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    const separator = line.indexOf("=");
    assert.ok(separator > 0, `Unexpected output line ${JSON.stringify(line)}.`);
    entries.push([line.slice(0, separator), line.slice(separator + 1)]);
  }

  return Object.fromEntries(entries);
}

async function readRegistryRequests(fixture: Fixture): Promise<string[]> {
  if (!existsSync(fixture.logPath)) {
    return [];
  }

  return (await readFile(fixture.logPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
}

function assertFailed(result: CheckerRun, expected: RegExp): void {
  assert.notEqual(
    result.status,
    0,
    `Expected the checker to fail. stdout=${result.stdout}`,
  );
  assert.match(result.stderr, expected);
}

function statuses(result: CheckerRun): Record<string, string> {
  const packages = result.json["packages"] as Array<Record<string, string>>;

  return Object.fromEntries(
    packages.map((entry) => [entry["slug"] as string, entry["status"] as string]),
  );
}

function order(result: CheckerRun): string[] {
  const packages = result.json["packages"] as Array<Record<string, string>>;

  return packages.map((entry) => entry["name"] as string);
}

function publishedState(
  version: string,
  tags: Readonly<Record<string, string>> = {},
  versions: readonly string[] = [version],
): Record<string, unknown> {
  return { mode: "published", versions, tags };
}

const ABSENT = { mode: "absent" } as const;

after(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("release train manifest validation", () => {
  it("accepts a complete release-candidate train without touching the registry", async () => {
    const fixture = await createFixture("candidate-train");
    const result = runChecker(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readOutputs(fixture), {
      version: "0.4.0-rc.1",
      stage: "rc",
      dist_tag: "next",
      publish_required: "true",
      sdk_status: "publish",
      cli_status: "publish",
      worker_status: "publish",
      publish_sdk: "true",
      publish_cli: "true",
      publish_worker: "true",
    });
    assert.deepEqual(order(result), [
      "@syndroo/sdk",
      "@syndroo/cli",
      "@syndroo/cloudflare-worker",
    ]);
    assert.equal(result.json["registryChecked"], false);
  });

  it("accepts a complete final train and resolves the latest dist-tag", async () => {
    const fixture = await createFixture("final-train", { version: "0.4.0" });
    const result = runChecker(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json["stage"], "final");
    assert.equal(result.json["distTag"], "latest");
    assert.equal((await readOutputs(fixture))["dist_tag"], "latest");
  });

  it("rejects packages that do not share one train version", async () => {
    const fixture = await createFixture("version-mismatch", {
      overrides: { cli: { version: "0.4.0-rc.2" } },
    });
    const result = runChecker(fixture);

    assertFailed(result, /must ship the same version/);
    assert.equal(result.json["ok"], false);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a CLI that does not depend on the exact SDK version", async () => {
    const fixture = await createFixture("dependency-range", {
      overrides: { cli: { dependencies: { "@syndroo/sdk": "^0.4.0-rc.1" } } },
    });

    assertFailed(
      runChecker(fixture),
      /must depend on exactly @syndroo\/sdk@0\.4\.0-rc\.1/,
    );
  });

  it("rejects a CLI pinned to a different SDK version", async () => {
    const fixture = await createFixture("dependency-pin", {
      overrides: { cli: { dependencies: { "@syndroo/sdk": "0.4.0-rc.0" } } },
    });

    assertFailed(
      runChecker(fixture),
      /must depend on exactly @syndroo\/sdk@0\.4\.0-rc\.1/,
    );
  });

  it("rejects a missing package in the train", async () => {
    const fixture = await createFixture("missing-package", { remove: ["cli"] });
    const result = runChecker(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release-train: @syndroo\/cli: ENOENT/u);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a package that is private by mistake", async () => {
    const fixture = await createFixture("private-package", {
      overrides: { worker: { private: true } },
    });

    assertFailed(runChecker(fixture), /must not be private/);
  });

  const manifestCases: ReadonlyArray<
    readonly [string, PackageKey, Record<string, unknown>, RegExp]
  > = [
    ["a wrong license", "sdk", { license: "MIT" }, /must use Apache-2\.0/],
    [
      "a foreign repository url",
      "sdk",
      { repository: { url: "git+https://github.com/other/x.git", directory: "packages/sdk" } },
      /repository URL does not match Syndroo\/syndroo/,
    ],
    [
      "a missing repository directory",
      "sdk",
      { repository: { type: "git", url: REPOSITORY_URL } },
      /repository directory must be packages\/sdk/,
    ],
    ["a missing publishConfig", "cli", { publishConfig: undefined }, /publishConfig\.access must be "public"/],
    ["a wrong engines range", "cli", { engines: { node: ">=20" } }, /engines\.node must be ">=22"/],
    ["a missing file entry", "worker", { files: ["dist", "LICENSE"] }, /"files" must include "migrations"/],
    ["a wrong bin target", "cli", { bin: { syndroo: "./bin/syndroo.js" } }, /bin syndroo must point at \.\/dist\/bin\.js/],
    ["a workspace protocol dependency", "cli", { dependencies: { "@syndroo/sdk": "workspace:^" } }, /workspace protocol/],
    ["a private runtime dependency", "worker", { dependencies: { "@syndroo/core": "0.1.0" } }, /must not depend on the private workspace package @syndroo\/core/],
    ["a malformed version", "sdk", { version: "0.4" }, /must be <major>\.<minor>\.<patch>/],
    ["a wrong package name", "sdk", { name: "@syndroo/other" }, /expected package name @syndroo\/sdk/],
  ];

  for (const [label, key, overrides, expected] of manifestCases) {
    it(`rejects ${label}`, async () => {
      const fixture = await createFixture(`manifest-${label.replaceAll(" ", "-")}`, {
        overrides: { [key]: overrides },
      });
      const result = runChecker(fixture);

      assertFailed(result, expected);
      assert.equal(result.json["ok"], false);
      assert.equal(existsSync(fixture.outputPath), false);
    });
  }
});

describe("release event agreement", () => {
  it("accepts a release candidate tagged as a prerelease", async () => {
    const fixture = await createFixture("release-event-rc");
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.4.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects a release tag that disagrees with the train version", async () => {
    const fixture = await createFixture("release-event-tag");
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.4.0",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assertFailed(result, /does not match the train version 0\.4\.0-rc\.1/);
  });

  it("rejects a stable train published as a GitHub prerelease", async () => {
    const fixture = await createFixture("release-event-stable", { version: "0.4.0" });
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.4.0",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assertFailed(result, /must be published as a non-prerelease GitHub release/);
  });

  it("rejects incomplete release metadata", async () => {
    const fixture = await createFixture("release-event-partial");
    const result = runChecker(fixture, {
      env: { GITHUB_EVENT_NAME: "release", SYNDROO_RELEASE_TAG: "v0.4.0-rc.1" },
    });

    assertFailed(result, /must be set together/);
  });
});

describe("dist-tag guard", () => {
  it("refuses to publish a release candidate under latest", async () => {
    const fixture = await createFixture("retag-flag");
    const result = runChecker(fixture, { args: ["--expect-dist-tag", "latest"] });

    assertFailed(result, /cannot be retagged as a stable release/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("refuses the same retag through the workflow environment variable", async () => {
    const fixture = await createFixture("retag-env");
    const result = runChecker(fixture, { env: { SYNDROO_DIST_TAG: "latest" } });

    assertFailed(result, /must publish under next/);
  });

  it("accepts the dist-tag the version implies", async () => {
    const fixture = await createFixture("retag-agreement");
    const result = runChecker(fixture, { args: ["--expect-dist-tag", "next"] });

    assert.equal(result.status, 0, result.stderr);
  });
});

describe("registry planning", () => {
  it("records every package as publishable when the registry has none of them", async () => {
    const fixture = await createFixture("registry-all-absent");
    await setRegistryState(fixture, {
      "@syndroo/sdk": ABSENT,
      "@syndroo/cli": ABSENT,
      "@syndroo/cloudflare-worker": ABSENT,
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), {
      sdk: "publish",
      cli: "publish",
      worker: "publish",
    });
    assert.equal(result.json["publishRequired"], true);
    assert.deepEqual(result.json["packages"], [
      {
        name: "@syndroo/sdk",
        slug: "sdk",
        version: "0.4.0-rc.1",
        distTag: "next",
        status: "publish",
        detail: "@syndroo/sdk@0.4.0-rc.1 is not published (HTTP 404)",
      },
      {
        name: "@syndroo/cli",
        slug: "cli",
        version: "0.4.0-rc.1",
        distTag: "next",
        status: "publish",
        detail: "@syndroo/cli@0.4.0-rc.1 is not published (HTTP 404)",
      },
      {
        name: "@syndroo/cloudflare-worker",
        slug: "worker",
        version: "0.4.0-rc.1",
        distTag: "next",
        status: "publish",
        detail: "@syndroo/cloudflare-worker@0.4.0-rc.1 is not published (HTTP 404)",
      },
    ]);
    assert.deepEqual(await readRegistryRequests(fixture), [
      "https://registry.npmjs.org/%40syndroo%2Fsdk",
      "https://registry.npmjs.org/%40syndroo%2Fcli",
      "https://registry.npmjs.org/%40syndroo%2Fcloudflare-worker",
    ]);
  });

  it("does not contact the registry unless the check is enabled", async () => {
    const fixture = await createFixture("registry-disabled-probe");
    const result = runChecker(fixture, { preload: true });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readRegistryRequests(fixture), []);
    assert.equal(result.json["registryChecked"], false);
  });

  it("accepts a fully published final train already on the latest tag", async () => {
    const fixture = await createFixture("registry-final-complete", { version: "0.4.0" });
    await setRegistryState(fixture, {
      "@syndroo/sdk": publishedState("0.4.0", { latest: "0.4.0", next: "0.3.0" }),
      "@syndroo/cli": publishedState("0.4.0", { latest: "0.4.0" }),
      "@syndroo/cloudflare-worker": publishedState("0.4.0", { latest: "0.4.0" }),
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), {
      sdk: "already-published",
      cli: "already-published",
      worker: "already-published",
    });
    assert.equal(result.json["publishRequired"], false);
    assert.match(String(result.json["nextStep"]), /nothing to publish/);
    assert.deepEqual(await readOutputs(fixture), {
      version: "0.4.0",
      stage: "final",
      dist_tag: "latest",
      publish_required: "false",
      sdk_status: "already-published",
      cli_status: "already-published",
      worker_status: "already-published",
      publish_sdk: "false",
      publish_cli: "false",
      publish_worker: "false",
    });
  });

  it("rejects a final train whose latest dist-tag points somewhere else", async () => {
    const fixture = await createFixture("registry-wrong-tag", { version: "0.4.0" });
    await setRegistryState(fixture, {
      "@syndroo/sdk": publishedState("0.4.0", { latest: "0.3.5" }),
      "@syndroo/cli": publishedState("0.4.0", { latest: "0.4.0" }),
      "@syndroo/cloudflare-worker": publishedState("0.4.0", { latest: "0.4.0" }),
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(
      result,
      /`latest` dist-tag for @syndroo\/sdk points at "0\.3\.5", not 0\.4\.0/,
    );
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a release candidate that is already the latest dist-tag", async () => {
    const fixture = await createFixture("registry-rc-on-latest");
    await setRegistryState(fixture, {
      "@syndroo/sdk": publishedState("0.4.0-rc.1", {
        latest: "0.4.0-rc.1",
        next: "0.4.0-rc.1",
      }),
      "@syndroo/cli": ABSENT,
      "@syndroo/cloudflare-worker": ABSENT,
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(result, /is already the `latest` dist-tag/);
  });

  it("reports a partly published train as publishable without republishing", async () => {
    const fixture = await createFixture("registry-partial");
    await setRegistryState(fixture, {
      "@syndroo/sdk": publishedState("0.4.0-rc.1", {
        latest: "0.2.0",
        next: "0.4.0-rc.1",
      }),
      "@syndroo/cli": ABSENT,
      "@syndroo/cloudflare-worker": ABSENT,
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), {
      sdk: "already-published",
      cli: "publish",
      worker: "publish",
    });
    assert.equal(result.json["publishRequired"], true);
    assert.match(
      String(result.json["nextStep"]),
      /Publish only @syndroo\/cli -> @syndroo\/cloudflare-worker/,
    );
    assert.match(String(result.json["nextStep"]), /must not be republished/);
    assert.equal((await readOutputs(fixture))["publish_sdk"], "false");
  });

  it("rejects a train whose packages are published out of order", async () => {
    const fixture = await createFixture("registry-order");
    await setRegistryState(fixture, {
      "@syndroo/sdk": ABSENT,
      "@syndroo/cli": publishedState("0.4.0-rc.1", { next: "0.4.0-rc.1" }),
      "@syndroo/cloudflare-worker": publishedState("0.4.0-rc.1", { next: "0.4.0-rc.1" }),
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(
      result,
      /Publish order violated: @syndroo\/cli is already published but @syndroo\/sdk is not/,
    );
    assert.equal(existsSync(fixture.outputPath), false);
  });

  for (const status of ["401", "403", "429", "500", "503"]) {
    it(`fails closed on registry HTTP ${status} and stops the train`, async () => {
      const fixture = await createFixture(`registry-${status}`);
      await setRegistryState(fixture, {
        "@syndroo/sdk": ABSENT,
        "@syndroo/cli": { mode: "http", status: Number(status) },
        "@syndroo/cloudflare-worker": ABSENT,
      });

      const result = runChecker(fixture, {
        preload: true,
        env: { SYNDROO_CHECK_REGISTRY: "true" },
      });

      assertFailed(
        result,
        new RegExp(`npm registry check failed \\(HTTP ${status}\\); refusing to publish`),
      );
      assert.deepEqual(statuses(result), {
        sdk: "publish",
        cli: "blocked",
        worker: "blocked",
      });
      assert.equal(existsSync(fixture.outputPath), false);
      // The Worker packument is never requested once the CLI check has failed.
      assert.deepEqual(await readRegistryRequests(fixture), [
        "https://registry.npmjs.org/%40syndroo%2Fsdk",
        "https://registry.npmjs.org/%40syndroo%2Fcli",
      ]);
    });
  }

  it("fails closed when the registry call throws", async () => {
    const fixture = await createFixture("registry-network-error");
    await setRegistryState(fixture, { "@syndroo/sdk": { mode: "network-error" } });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(result, /network failure: simulated registry network failure/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("fails closed on a packument the checker cannot read", async () => {
    const fixture = await createFixture("registry-unreadable");
    await setRegistryState(fixture, { "@syndroo/sdk": { mode: "unreadable" } });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(result, /npm registry check failed \(unreadable packument/);
  });
});

describe("partial publish recovery", () => {
  it("stops after the CLI publish fails and never announces a finished train", async () => {
    const fixture = await createFixture("recovery-failure");
    await setRegistryState(fixture, {
      "@syndroo/sdk": publishedState("0.4.0-rc.1", {
        latest: "0.2.0",
        next: "0.4.0-rc.1",
      }),
      "@syndroo/cli": { mode: "http", status: 500 },
      "@syndroo/cloudflare-worker": ABSENT,
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.json["ok"], false);
    assert.deepEqual(statuses(result), {
      sdk: "already-published",
      cli: "blocked",
      worker: "blocked",
    });

    const packages = result.json["packages"] as Array<Record<string, string>>;

    assert.equal(
      packages[2]?.["detail"],
      "not attempted; an earlier registry check or package in the train failed",
    );
    assert.equal(existsSync(fixture.outputPath), false);
    assert.deepEqual(await readRegistryRequests(fixture), [
      "https://registry.npmjs.org/%40syndroo%2Fsdk",
      "https://registry.npmjs.org/%40syndroo%2Fcli",
    ]);
  });

  it("resumes on the remaining packages and never republishes the SDK", async () => {
    const fixture = await createFixture("recovery-resume");
    await setRegistryState(fixture, {
      "@syndroo/sdk": publishedState("0.4.0-rc.1", {
        latest: "0.2.0",
        next: "0.4.0-rc.1",
      }),
      "@syndroo/cli": ABSENT,
      "@syndroo/cloudflare-worker": ABSENT,
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), {
      sdk: "already-published",
      cli: "publish",
      worker: "publish",
    });
    assert.match(result.stderr, /already published, skipping: @syndroo\/sdk/);

    const outputs = await readOutputs(fixture);

    // No publish action is ever planned for the SDK, so the published version
    // can never be overwritten by a resumed run.
    assert.equal(outputs["publish_sdk"], "false");
    assert.equal(outputs["sdk_status"], "already-published");
    assert.equal(outputs["publish_cli"], "true");
    assert.equal(outputs["publish_worker"], "true");
  });
});
