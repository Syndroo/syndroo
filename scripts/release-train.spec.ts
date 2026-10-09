import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RELEASE_TRAIN,
  REPOSITORY_URL,
  REQUIRED_NODE_ENGINE,
  type TrainPackage,
} from "./release-train.js";

/**
 * The train under test is the module's own `RELEASE_TRAIN`, so this suite can
 * never drift from the packages the checker actually validates. Every fixture
 * is built from those definitions; nothing is hard-coded per package.
 */
const CHECKER_PATH = fileURLToPath(new URL("./release-train.js", import.meta.url));
const FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "syndroo-release-train-"));
const CANDIDATE = "0.7.0-rc.1";
const STABLE = "0.7.0";

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

type Fixture = {
  readonly dir: string;
  readonly outputPath: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly preloadPath: string;
};

type CreateOptions = {
  readonly version?: string;
  readonly overrides?: Readonly<Record<string, Record<string, unknown>>>;
  readonly remove?: readonly string[];
  /** Extra workspace directories written beside the train packages. */
  readonly extraWorkspaces?: Readonly<Record<string, Record<string, unknown>>>;
  /** Root `workspaces` array; omitted fixtures declare no workspaces. */
  readonly workspaces?: readonly string[];
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
  options: CreateOptions = {},
): Promise<Fixture> {
  const dir = join(FIXTURE_ROOT, name);
  const version = options.version ?? CANDIDATE;

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "syndroo",
        private: true,
        version: "0.1.0",
        ...(options.workspaces === undefined
          ? {}
          : { workspaces: [...options.workspaces] }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const definition of RELEASE_TRAIN) {
    if (options.remove?.includes(definition.slug) === true) {
      continue;
    }

    await writePackage(dir, definition.directory, {
      name: definition.name,
      version,
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: REPOSITORY_URL,
        directory: definition.directory,
      },
      engines: { node: REQUIRED_NODE_ENGINE },
      publishConfig: { access: "public" },
      files: [...definition.requiredFiles],
      ...(Object.keys(definition.requiredBins).length === 0
        ? {}
        : { bin: { ...definition.requiredBins } }),
      ...(definition.dependsOn === undefined
        ? {}
        : { dependencies: { [definition.dependsOn]: version } }),
      ...(options.overrides?.[definition.slug] ?? {}),
    });
  }

  for (const [directory, manifest] of Object.entries(
    options.extraWorkspaces ?? {},
  )) {
    await writePackage(dir, directory, manifest);
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

async function writePackage(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const packageDirectory = join(root, directory);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function setRegistryState(
  fixture: Fixture,
  state: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function runChecker(fixture: Fixture, options: RunOptions = {}): CheckerRun {
  // The ambient release set is only what the caller supplied: a CI job that
  // exports SYNDROO_RELEASE_SET must not silently retarget a fixture. Every
  // fixture therefore starts from an explicit default and overrides it per test.
  const env: Record<string, string> = {
    SYNDROO_RELEASE_SET: "all",
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

function trainNames(): string[] {
  return RELEASE_TRAIN.map((definition) => definition.name);
}

function everyTrain(status: string): Record<string, string> {
  return Object.fromEntries(RELEASE_TRAIN.map((definition) => [definition.slug, status]));
}

function packumentUrl(name: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`;
}

/** The exact GitHub-output lines a run must write, derived from the train. */
function expectedOutputs(options: {
  readonly releaseSet?: string;
  readonly version: string;
  readonly stage: string;
  readonly distTag: string;
  readonly publishRequired: boolean;
  readonly statuses: Readonly<Record<string, string>>;
}): Record<string, string> {
  const outputs: Record<string, string> = {
    release_set: options.releaseSet ?? "all",
    version: options.version,
    stage: options.stage,
    dist_tag: options.distTag,
    publish_required: String(options.publishRequired),
  };

  for (const [slug, status] of Object.entries(options.statuses)) {
    outputs[`${slug}_status`] = status;
    outputs[`publish_${slug}`] = String(status === "publish");
  }

  return outputs;
}

/** The `packages` array for a registry run where every train package is absent. */
function absentPlan(version: string): unknown[] {
  return RELEASE_TRAIN.map((definition) => ({
    name: definition.name,
    slug: definition.slug,
    version,
    distTag: "next",
    status: "publish",
    detail: `${definition.name}@${version} is not published (HTTP 404)`,
  }));
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
    assert.deepEqual(
      await readOutputs(fixture),
      expectedOutputs({
        version: CANDIDATE,
        stage: "rc",
        distTag: "next",
        publishRequired: true,
        statuses: everyTrain("publish"),
      }),
    );
    assert.deepEqual(order(result), trainNames());
    assert.equal(result.json["registryChecked"], false);
  });

  it("accepts a complete final train and resolves the latest dist-tag", async () => {
    const fixture = await createFixture("final-train", { version: STABLE });
    const result = runChecker(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json["stage"], "final");
    assert.equal(result.json["distTag"], "latest");
    assert.equal((await readOutputs(fixture))["dist_tag"], "latest");
  });

  it("rejects packages that do not share one train version", async () => {
    const fixture = await createFixture("version-mismatch", {
      overrides: { cli: { version: "0.7.0-rc.2" } },
    });
    const result = runChecker(fixture);

    assertFailed(result, /must ship the same version/);
    assert.equal(result.json["ok"], false);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a CLI that does not depend on the exact provider-sdk version", async () => {
    const fixture = await createFixture("dependency-range", {
      overrides: {
        cli: { dependencies: { "@syndroo/provider-sdk": `^${CANDIDATE}` } },
      },
    });

    assertFailed(
      runChecker(fixture),
      /must depend on exactly @syndroo\/provider-sdk@0\.7\.0-rc\.1/,
    );
  });

  it("rejects a CLI pinned to a different provider-sdk version", async () => {
    const fixture = await createFixture("dependency-pin", {
      overrides: {
        cli: { dependencies: { "@syndroo/provider-sdk": "0.7.0-rc.0" } },
      },
    });

    assertFailed(
      runChecker(fixture),
      /must depend on exactly @syndroo\/provider-sdk@0\.7\.0-rc\.1/,
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
      overrides: { cloudflare: { private: true } },
    });

    assertFailed(runChecker(fixture), /must not be private/);
  });

  const firstTrainPackage: TrainPackage = RELEASE_TRAIN[0] as TrainPackage;

  const manifestCases: ReadonlyArray<
    readonly [string, string, Record<string, unknown>, RegExp]
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
    ["a wrong engines range", "cli", { engines: { node: ">=22" } }, new RegExp(`engines\\.node must be "${REQUIRED_NODE_ENGINE.replace(/[.]/gu, "\\.")}"`)],
    ["a missing file entry", "cloudflare", { files: ["dist/worker.js", "LICENSE"] }, /"files" must include "dist\/index\.d\.ts"/],
    ["a wrong bin target", "cli", { bin: { syndroo: "./bin/syndroo.js" } }, /bin syndroo must point at \.\/dist\/bin\.js/],
    ["a workspace protocol dependency", "cli", { dependencies: { "@syndroo/provider-sdk": "workspace:^" } }, /workspace protocol/],
    ["a private runtime dependency", "cloudflare", { dependencies: { "@syndroo/core": "0.1.0" } }, /must not depend on the private workspace package @syndroo\/core/],
    ["a malformed version", "provider-sdk", { version: "0.7" }, /must be <major>\.<minor>\.<patch>/],
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

  it("names the first train package in the order it publishes", async () => {
    assert.equal(firstTrainPackage.name, "@syndroo/provider-sdk");
  });
});

describe("workspace coverage", () => {
  it("accepts a workspace set fully covered by the train plus private packages", async () => {
    const fixture = await createFixture("coverage-ok", {
      workspaces: [
        ...RELEASE_TRAIN.map((definition) => definition.directory),
        "packages/core",
      ],
      extraWorkspaces: {
        "packages/core": {
          name: "@syndroo/core",
          version: CANDIDATE,
          private: true,
        },
      },
    });

    const result = runChecker(fixture);

    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects a public workspace that is not in the train", async () => {
    const fixture = await createFixture("coverage-public-extra", {
      workspaces: [
        ...RELEASE_TRAIN.map((definition) => definition.directory),
        "packages/extra",
      ],
      extraWorkspaces: {
        "packages/extra": { name: "@syndroo/extra", version: CANDIDATE },
      },
    });

    assertFailed(
      runChecker(fixture),
      /workspace packages\/extra \(@syndroo\/extra\) is public but is not in the release train/,
    );
  });

  it("rejects a train entry that is not a declared workspace", async () => {
    const fixture = await createFixture("coverage-train-missing", {
      workspaces: RELEASE_TRAIN.filter((definition) => definition.slug !== "sdk").map(
        (definition) => definition.directory,
      ),
    });

    assertFailed(
      runChecker(fixture),
      /@syndroo\/sdk is in the release train but packages\/sdk is not a declared workspace/,
    );
  });
});

describe("release event agreement", () => {
  it("accepts a release candidate tagged as a prerelease", async () => {
    const fixture = await createFixture("release-event-rc");
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: `v${CANDIDATE}`,
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
        SYNDROO_RELEASE_TAG: `v${STABLE}`,
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assertFailed(result, /does not match the train version 0\.7\.0-rc\.1/);
  });

  it("rejects a stable train published as a GitHub prerelease", async () => {
    const fixture = await createFixture("release-event-stable", { version: STABLE });
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: `v${STABLE}`,
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assertFailed(result, /must be published as a non-prerelease GitHub release/);
  });

  it("rejects incomplete release metadata", async () => {
    const fixture = await createFixture("release-event-partial");
    const result = runChecker(fixture, {
      env: { GITHUB_EVENT_NAME: "release", SYNDROO_RELEASE_TAG: `v${CANDIDATE}` },
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
    await setRegistryState(
      fixture,
      Object.fromEntries(RELEASE_TRAIN.map((definition) => [definition.name, ABSENT])),
    );

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), everyTrain("publish"));
    assert.equal(result.json["publishRequired"], true);
    assert.deepEqual(result.json["packages"], absentPlan(CANDIDATE));
    assert.deepEqual(
      await readRegistryRequests(fixture),
      RELEASE_TRAIN.map((definition) => packumentUrl(definition.name)),
    );
  });

  it("does not contact the registry unless the check is enabled", async () => {
    const fixture = await createFixture("registry-disabled-probe");
    const result = runChecker(fixture, { preload: true });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readRegistryRequests(fixture), []);
    assert.equal(result.json["registryChecked"], false);
  });

  it("accepts a fully published final train already on the latest tag", async () => {
    const fixture = await createFixture("registry-final-complete", { version: STABLE });
    await setRegistryState(
      fixture,
      Object.fromEntries(
        RELEASE_TRAIN.map((definition) => [
          definition.name,
          publishedState(STABLE, { latest: STABLE }),
        ]),
      ),
    );

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), everyTrain("already-published"));
    assert.equal(result.json["publishRequired"], false);
    assert.match(String(result.json["nextStep"]), /nothing to publish/);
    assert.deepEqual(
      await readOutputs(fixture),
      expectedOutputs({
        version: STABLE,
        stage: "final",
        distTag: "latest",
        publishRequired: false,
        statuses: everyTrain("already-published"),
      }),
    );
  });

  it("rejects a final train whose latest dist-tag points somewhere else", async () => {
    const fixture = await createFixture("registry-wrong-tag", { version: STABLE });
    await setRegistryState(
      fixture,
      Object.fromEntries(
        RELEASE_TRAIN.map((definition) => [
          definition.name,
          publishedState(
            STABLE,
            definition.name === "@syndroo/sdk"
              ? { latest: "0.6.5" }
              : { latest: STABLE },
          ),
        ]),
      ),
    );

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(
      result,
      /`latest` dist-tag for @syndroo\/sdk points at "0\.6\.5", not 0\.7\.0/,
    );
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a release candidate that is already the latest dist-tag", async () => {
    const fixture = await createFixture("registry-rc-on-latest");
    await setRegistryState(fixture, {
      "@syndroo/provider-sdk": publishedState(CANDIDATE, {
        latest: CANDIDATE,
        next: CANDIDATE,
      }),
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
      "@syndroo/provider-sdk": publishedState(CANDIDATE, {
        latest: "0.6.0",
        next: CANDIDATE,
      }),
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(statuses(result)["provider-sdk"], "already-published");
    assert.equal(statuses(result)["cli"], "publish");
    assert.equal(result.json["publishRequired"], true);
    assert.match(
      String(result.json["nextStep"]),
      /Publish only @syndroo\/provider-bluesky/,
    );
    assert.match(String(result.json["nextStep"]), /must not be republished/);
    assert.equal((await readOutputs(fixture))["publish_provider-sdk"], "false");
  });

  it("rejects a train whose packages are published out of order", async () => {
    const fixture = await createFixture("registry-order");
    await setRegistryState(fixture, {
      "@syndroo/provider-sdk": ABSENT,
      "@syndroo/cli": publishedState(CANDIDATE, { next: CANDIDATE }),
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(
      result,
      /Publish order violated: @syndroo\/cli is already published but @syndroo\/provider-sdk is not/,
    );
    assert.equal(existsSync(fixture.outputPath), false);
  });

  for (const status of ["401", "403", "429", "500", "503"]) {
    it(`fails closed on registry HTTP ${status} and stops the train`, async () => {
      const fixture = await createFixture(`registry-${status}`);
      await setRegistryState(fixture, {
        "@syndroo/provider-bluesky": { mode: "http", status: Number(status) },
      });

      const result = runChecker(fixture, {
        preload: true,
        env: { SYNDROO_CHECK_REGISTRY: "true" },
      });

      assertFailed(
        result,
        new RegExp(`npm registry check failed \\(HTTP ${status}\\); refusing to publish`),
      );
      const after = statuses(result);

      assert.equal(after["provider-sdk"], "publish");
      assert.equal(after["provider-bluesky"], "blocked");
      assert.equal(after["cli"], "blocked");
      assert.equal(existsSync(fixture.outputPath), false);
      // No packument beyond the failing one is requested.
      assert.deepEqual(await readRegistryRequests(fixture), [
        packumentUrl("@syndroo/provider-sdk"),
        packumentUrl("@syndroo/provider-bluesky"),
      ]);
    });
  }

  it("fails closed when the registry call throws", async () => {
    const fixture = await createFixture("registry-network-error");
    await setRegistryState(fixture, {
      "@syndroo/provider-sdk": { mode: "network-error" },
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(result, /network failure: simulated registry network failure/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("fails closed on a packument the checker cannot read", async () => {
    const fixture = await createFixture("registry-unreadable");
    await setRegistryState(fixture, {
      "@syndroo/provider-sdk": { mode: "unreadable" },
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assertFailed(result, /npm registry check failed \(unreadable packument/);
  });
});

describe("partial publish recovery", () => {
  it("stops after a mid-train publish fails and never announces a finished train", async () => {
    const fixture = await createFixture("recovery-failure");
    await setRegistryState(fixture, {
      "@syndroo/provider-sdk": publishedState(CANDIDATE, {
        latest: "0.6.0",
        next: CANDIDATE,
      }),
      "@syndroo/provider-bluesky": { mode: "http", status: 500 },
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.json["ok"], false);

    const after = statuses(result);

    assert.equal(after["provider-sdk"], "already-published");
    assert.equal(after["provider-bluesky"], "blocked");
    assert.equal(after["cli"], "blocked");

    const packages = result.json["packages"] as Array<Record<string, string>>;
    const cliEntry = packages.find((entry) => entry["slug"] === "cli");

    assert.equal(
      cliEntry?.["detail"],
      "not attempted; an earlier registry check or package in the train failed",
    );
    assert.equal(existsSync(fixture.outputPath), false);
    assert.deepEqual(await readRegistryRequests(fixture), [
      packumentUrl("@syndroo/provider-sdk"),
      packumentUrl("@syndroo/provider-bluesky"),
    ]);
  });

  it("resumes on the remaining packages and never republishes the first one", async () => {
    const fixture = await createFixture("recovery-resume");
    await setRegistryState(fixture, {
      "@syndroo/provider-sdk": publishedState(CANDIDATE, {
        latest: "0.6.0",
        next: CANDIDATE,
      }),
    });

    const result = runChecker(fixture, {
      preload: true,
      env: { SYNDROO_CHECK_REGISTRY: "true" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(statuses(result)["provider-sdk"], "already-published");
    assert.equal(statuses(result)["cli"], "publish");
    assert.match(
      result.stderr,
      /already published, skipping: @syndroo\/provider-sdk/,
    );

    const outputs = await readOutputs(fixture);

    // No publish action is ever planned for the published package, so a resumed
    // run can never overwrite it.
    assert.equal(outputs["publish_provider-sdk"], "false");
    assert.equal(outputs["provider-sdk_status"], "already-published");
    assert.equal(outputs["publish_cli"], "true");
  });
});

/**
 * The narrowed CLI release set. It publishes only `@syndroo/cli`, but it never
 * relaxes the exact-version pin on the packages the CLI builds against.
 */
describe("cli release set", () => {
  it("narrows the set to the CLI at the train version", async () => {
    const fixture = await createFixture("cli-set-candidate");
    const result = runChecker(fixture, {
      env: { SYNDROO_RELEASE_SET: "cli" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statuses(result), { cli: "publish" });

    const outputs = await readOutputs(fixture);

    assert.equal(outputs["release_set"], "cli");
    assert.equal(outputs["version"], CANDIDATE);
    assert.equal(outputs["dist_tag"], "next");
    assert.equal(outputs["cli_status"], "publish");
    assert.equal(outputs["publish_cli"], "true");
    // Every other train package is out of the set, so it is not planned at all.
    assert.equal(outputs["provider-sdk_status"], undefined);
    assert.equal(outputs["cloudflare_status"], undefined);
  });

  it("still enforces the CLI's exact provider-sdk pin", async () => {
    const fixture = await createFixture("cli-set-coupled", {
      overrides: {
        cli: { dependencies: { "@syndroo/provider-sdk": `^${CANDIDATE}` } },
      },
    });

    const result = runChecker(fixture, {
      env: { SYNDROO_RELEASE_SET: "cli" },
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /must depend on exactly @syndroo\/provider-sdk@0\.7\.0-rc\.1/u,
    );
  });

  it("rejects an unknown release set instead of falling back", async () => {
    const fixture = await createFixture("cli-set-unknown");

    const result = runChecker(fixture, {
      env: { SYNDROO_RELEASE_SET: "cli-and-cloudflare" },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SYNDROO_RELEASE_SET must be "all" or "cli"/u);
  });
});
