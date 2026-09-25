import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIRECTORY = "packages/cloudflare-worker";
const REPOSITORY_URL = "git+https://github.com/Syndroo/syndroo.git";
const CHECKER_PATH = fileURLToPath(
  new URL("./check-release.js", import.meta.url),
);
const FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "syndroo-release-check-"));

assert.ok(
  existsSync(CHECKER_PATH),
  `Compiled checker missing at ${CHECKER_PATH}. Run \`npm run build:scripts\` first.`,
);

// The preload replaces global fetch so registry tests never touch the network.
const FAKE_REGISTRY_MODULE = [
  'import { appendFileSync } from "node:fs";',
  "",
  "const logPath = process.env.FAKE_REGISTRY_LOG;",
  "",
  "globalThis.fetch = async (url) => {",
  "  if (logPath !== undefined && logPath.length > 0) {",
  '    appendFileSync(logPath, String(url) + "\\n");',
  "  }",
  "",
  '  const status = process.env.FAKE_REGISTRY_STATUS ?? "500";',
  "",
  '  if (status === "network-error") {',
  '    throw new TypeError("simulated registry network failure");',
  "  }",
  "",
  "  return new Response(null, { status: Number(status) });",
  "};",
  "",
].join("\n");

const BASE_MANIFEST: Readonly<Record<string, unknown>> = {
  name: "@syndroo/cloudflare-worker",
  version: "0.2.0",
  license: "Apache-2.0",
  repository: {
    type: "git",
    url: REPOSITORY_URL,
    directory: PACKAGE_DIRECTORY,
  },
};

/**
 * The 0.6 candidate publishes the CLI alone, at a version the Worker does not
 * share. The legacy Worker layout above stays the default.
 */
const CLI_DIRECTORY = "packages/cli";
const CLI_LAYOUT = {
  directory: CLI_DIRECTORY,
  base: {
    name: "@syndroo/cli",
    version: "0.6.0-rc.1",
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: REPOSITORY_URL,
      directory: CLI_DIRECTORY,
    },
  },
} as const;

type Fixture = {
  readonly dir: string;
  readonly outputPath: string;
  readonly preloadPath: string;
  readonly logPath: string;
};

type CheckerRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type RunOptions = {
  readonly env?: Readonly<Record<string, string>>;
  readonly preload?: boolean;
  readonly output?: boolean;
};

async function createFixture(
  name: string,
  manifestOverrides: Readonly<Record<string, unknown>> = {},
  layout: {
    readonly directory?: string;
    readonly base?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<Fixture> {
  const dir = join(FIXTURE_ROOT, name);
  const outputPath = join(dir, "github-output.txt");
  const preloadPath = join(dir, "fake-registry.mjs");
  const logPath = join(dir, "registry-requests.log");
  const packageDir = join(dir, layout.directory ?? PACKAGE_DIRECTORY);

  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      { ...(layout.base ?? BASE_MANIFEST), ...manifestOverrides },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(preloadPath, FAKE_REGISTRY_MODULE, "utf8");

  return { dir, outputPath, preloadPath, logPath };
}

function runChecker(fixture: Fixture, options: RunOptions = {}): CheckerRun {
  // Pinned rather than inherited: a CI job that exports SYNDROO_RELEASE_SET=cli
  // must not silently retarget the legacy Worker fixtures at the CLI package.
  const env: Record<string, string> = {
    SYNDROO_RELEASE_SET: "all",
    PATH: process.env["PATH"] ?? "",
    ...options.env,
  };

  if (options.output !== false) {
    env["GITHUB_OUTPUT"] = fixture.outputPath;
  }

  if (options.preload === true) {
    env["FAKE_REGISTRY_LOG"] = fixture.logPath;
  }

  const args =
    options.preload === true
      ? [
          "--import",
          pathToFileURL(fixture.preloadPath).href,
          CHECKER_PATH,
        ]
      : [CHECKER_PATH];

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

  const raw = await readFile(fixture.logPath, "utf8");

  return raw.split("\n").filter((line) => line.length > 0);
}

function assertFailed(result: CheckerRun, expected: RegExp): void {
  assert.notEqual(
    result.status,
    0,
    `Expected the checker to fail. stdout=${result.stdout}`,
  );
  assert.match(result.stderr, expected);
}

function registryEnv(status: string): Record<string, string> {
  return {
    SYNDROO_CHECK_REGISTRY: "true",
    FAKE_REGISTRY_STATUS: status,
  };
}

after(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("release channel", () => {
  it("maps a stable version to the latest dist-tag", async () => {
    const fixture = await createFixture("stable", { version: "0.2.0" });
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.2.0",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readOutputs(fixture), {
      package: "@syndroo/cloudflare-worker",
      version: "0.2.0",
      published: "false",
      dist_tag: "latest",
    });
    assert.equal(JSON.parse(result.stdout).distTag, "latest");
  });

  it("maps a release candidate to the next dist-tag", async () => {
    const fixture = await createFixture("candidate", { version: "0.2.0-rc.1" });
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readOutputs(fixture), {
      package: "@syndroo/cloudflare-worker",
      version: "0.2.0-rc.1",
      published: "false",
      dist_tag: "next",
    });
    assert.equal(JSON.parse(result.stdout).releaseTag, "v0.2.0-rc.1");
  });

  it("accepts a later release candidate number", async () => {
    const fixture = await createFixture("candidate-12", {
      version: "0.2.0-rc.12",
    });
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.12",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readOutputs(fixture))["dist_tag"], "next");
  });

  it("validates without release event variables", async () => {
    const fixture = await createFixture("workflow-dispatch");
    const result = runChecker(fixture, {
      env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readOutputs(fixture), {
      package: "@syndroo/cloudflare-worker",
      version: "0.2.0",
      published: "false",
      dist_tag: "latest",
    });
    assert.equal(JSON.parse(result.stdout).releaseTag, null);
  });

  it("validates locally without any GitHub event variables", async () => {
    const fixture = await createFixture("local-run");
    const result = runChecker(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readOutputs(fixture))["dist_tag"], "latest");
  });

  it("runs without a GitHub output file", async () => {
    const fixture = await createFixture("no-output", { version: "0.2.0-rc.1" });
    const result = runChecker(fixture, {
      output: false,
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(fixture.outputPath), false);
    assert.equal(JSON.parse(result.stdout).distTag, "next");
  });
});

describe("release event agreement", () => {
  it("rejects a tag that does not match the package version", async () => {
    const fixture = await createFixture("tag-mismatch");
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.1",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assertFailed(result, /does not match package version 0\.2\.0/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a tag without the v prefix", async () => {
    const fixture = await createFixture("tag-prefix");
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "0.2.0",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assertFailed(result, /does not match package version 0\.2\.0/);
  });

  it("rejects a stable version published as a GitHub prerelease", async () => {
    const fixture = await createFixture("stable-as-prerelease");
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.0",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assertFailed(result, /must be published as a non-prerelease GitHub release/);
  });

  it("rejects a release candidate published without the prerelease flag", async () => {
    const fixture = await createFixture("candidate-as-stable", {
      version: "0.2.0-rc.1",
    });
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assertFailed(result, /must be published as a GitHub prerelease/);
  });

  it("rejects a release tag without a prerelease flag", async () => {
    const fixture = await createFixture("tag-only");
    const result = runChecker(fixture, {
      env: { SYNDROO_RELEASE_TAG: "v0.2.0" },
    });

    assertFailed(result, /must be set together/);
  });

  it("rejects a prerelease flag without a release tag", async () => {
    const fixture = await createFixture("flag-only");
    const result = runChecker(fixture, {
      env: { SYNDROO_RELEASE_PRERELEASE: "false" },
    });

    assertFailed(result, /must be set together/);
  });

  it("rejects a release event without any release metadata", async () => {
    const fixture = await createFixture("release-without-metadata");
    const result = runChecker(fixture, {
      env: { GITHUB_EVENT_NAME: "release" },
    });

    assertFailed(result, /must be set together/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("rejects a release event with only a tag", async () => {
    const fixture = await createFixture("release-tag-only");
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.2.0",
      },
    });

    assertFailed(result, /must be set together/);
  });

  it("rejects a release event with only a prerelease flag", async () => {
    const fixture = await createFixture("release-flag-only");
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assertFailed(result, /must be set together/);
  });

  for (const flag of ["TRUE", "yes", "1", "false "]) {
    it(`rejects the non-boolean prerelease flag ${JSON.stringify(flag)}`, async () => {
      const fixture = await createFixture(`flag-${flag.trim()}`);
      const result = runChecker(fixture, {
        env: {
          SYNDROO_RELEASE_TAG: "v0.2.0",
          SYNDROO_RELEASE_PRERELEASE: flag,
        },
      });

      assertFailed(result, /must be "true" or "false"/);
    });
  }
});

describe("manifest guardrails", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> =
    [
      [
        "another package name",
        { name: "@syndroo/other" },
        /Expected package name @syndroo\/cloudflare-worker/,
      ],
      ["a private package", { private: true }, /must not be private/],
      ["another license", { license: "MIT" }, /must use Apache-2\.0/],
      [
        "another repository URL",
        {
          repository: {
            type: "git",
            url: "git+https://github.com/other/syndroo.git",
          },
        },
        /must not match Syndroo\/syndroo|does not match Syndroo\/syndroo/,
      ],
      [
        "a missing repository",
        { repository: undefined },
        /does not match Syndroo\/syndroo/,
      ],
      [
        "a missing version",
        { version: undefined },
        /must include name and version/,
      ],
    ];

  for (const [label, overrides, expected] of cases) {
    it(`rejects ${label}`, async () => {
      const fixture = await createFixture(
        `manifest-${label.replaceAll(" ", "-")}`,
        overrides,
      );
      const result = runChecker(fixture, {
        env: {
          SYNDROO_RELEASE_TAG: "v0.2.0",
          SYNDROO_RELEASE_PRERELEASE: "false",
        },
      });

      assertFailed(result, expected);
      assert.equal(existsSync(fixture.outputPath), false);
    });
  }
});

describe("malformed versions", () => {
  const versions = [
    "0.2",
    "0.2.0.1",
    "v0.2.0",
    "00.2.0",
    "0.2.0-rc",
    "0.2.0-rc.0",
    "0.2.0-rc.01",
    "0.2.0-rc.1.2",
    "0.2.0-rc.1-",
    "0.2.0-RC.1",
    "0.2.0-beta.1",
    "0.2.0+build.1",
    " 0.2.0",
    "0.2.0 ",
    "0.2.0\n",
    "0.2.0-rc.1\npublished=true",
  ];

  versions.forEach((version, index) => {
    it(`rejects version ${JSON.stringify(version)}`, async () => {
      const fixture = await createFixture(`version-${String(index)}`, {
        version,
      });
      const result = runChecker(fixture, {
        env: {
          SYNDROO_RELEASE_TAG: `v${version.trim()}`,
          SYNDROO_RELEASE_PRERELEASE: "false",
        },
      });

      assertFailed(result, /must be <major>\.<minor>\.<patch>/);
      assert.equal(existsSync(fixture.outputPath), false);
    });
  });

  it("does not leak injected manifest values into the GitHub output", async () => {
    const fixture = await createFixture("version-injection", {
      version: "0.2.0-rc.1\npublished=true\ndist_tag=latest",
    });
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assertFailed(result, /must be <major>\.<minor>\.<patch>/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("writes exactly the three expected outputs", async () => {
    const fixture = await createFixture("output-shape", {
      version: "0.2.0-rc.3",
    });
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.3",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(await readOutputs(fixture)).sort(), [
      "dist_tag",
      "package",
      "published",
      "version",
    ]);
  });
});

describe("registry check", () => {
  it("does not contact the registry unless the check is enabled", async () => {
    const fixture = await createFixture("registry-disabled");
    const result = runChecker(fixture, { preload: true });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readRegistryRequests(fixture), []);
    assert.equal((await readOutputs(fixture))["published"], "false");
  });

  it("treats HTTP 404 as an unpublished version", async () => {
    const fixture = await createFixture("registry-404");
    const result = runChecker(fixture, {
      preload: true,
      env: registryEnv("404"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readRegistryRequests(fixture), [
      "https://registry.npmjs.org/%40syndroo%2Fcloudflare-worker/0.2.0",
    ]);
    assert.equal((await readOutputs(fixture))["published"], "false");
  });

  it("treats HTTP 200 as an already published version", async () => {
    const fixture = await createFixture("registry-200", {
      version: "0.2.0-rc.1",
    });
    const result = runChecker(fixture, {
      preload: true,
      env: {
        ...registryEnv("200"),
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readOutputs(fixture), {
      package: "@syndroo/cloudflare-worker",
      version: "0.2.0-rc.1",
      published: "true",
      dist_tag: "next",
    });
  });

  for (const status of ["403", "429", "500", "503"]) {
    it(`fails closed on HTTP ${status}`, async () => {
      const fixture = await createFixture(`registry-${status}`);
      const result = runChecker(fixture, {
        preload: true,
        env: registryEnv(status),
      });

      assertFailed(result, new RegExp(`HTTP ${status}; refusing to publish`));
      assert.equal(existsSync(fixture.outputPath), false);
    });
  }

  it("fails closed when the registry call throws", async () => {
    const fixture = await createFixture("registry-network-error");
    const result = runChecker(fixture, {
      preload: true,
      env: registryEnv("network-error"),
    });

    assertFailed(result, /npm registry check failed: simulated registry network failure/);
    assert.equal(existsSync(fixture.outputPath), false);
  });
});

/**
 * The CLI-only release set. Before this existed the checker always read the
 * Worker manifest, so a `v0.6.0-rc.1` event validated version 0.2.0 and failed
 * the release for the wrong package.
 */
describe("cli release set", () => {
  it("validates the CLI manifest for a matching candidate tag", async () => {
    const fixture = await createFixture("cli-candidate", {}, CLI_LAYOUT);
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_SET: "cli",
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.6.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readOutputs(fixture), {
      package: "@syndroo/cli",
      version: "0.6.0-rc.1",
      published: "false",
      dist_tag: "next",
    });
    assert.equal(JSON.parse(result.stdout).package, "@syndroo/cli");
    assert.equal(JSON.parse(result.stdout).releaseSet, "cli");
  });

  it("rejects a Worker release tag while validating the CLI", async () => {
    const fixture = await createFixture("cli-wrong-tag", {}, CLI_LAYOUT);
    const result = runChecker(fixture, {
      env: {
        SYNDROO_RELEASE_SET: "cli",
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.2.0-rc.1",
        SYNDROO_RELEASE_PRERELEASE: "true",
      },
    });

    assertFailed(result, /does not match package version/);
    assert.equal(existsSync(fixture.outputPath), false);
  });

  it("keeps the Worker as the default target when no set is selected", async () => {
    const fixture = await createFixture("cli-default-worker");
    const result = runChecker(fixture, {
      env: {
        GITHUB_EVENT_NAME: "release",
        SYNDROO_RELEASE_TAG: "v0.2.0",
        SYNDROO_RELEASE_PRERELEASE: "false",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).package,
      "@syndroo/cloudflare-worker",
    );
    assert.equal(JSON.parse(result.stdout).releaseSet, "all");
  });

  it("fails closed on an unknown release set", async () => {
    const fixture = await createFixture("cli-unknown-set", {}, CLI_LAYOUT);
    const result = runChecker(fixture, {
      env: { SYNDROO_RELEASE_SET: "sdk" },
    });

    assertFailed(result, /SYNDROO_RELEASE_SET must be "all" or "cli"/);
    assert.equal(existsSync(fixture.outputPath), false);
  });
});
