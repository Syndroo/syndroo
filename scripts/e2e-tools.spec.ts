import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_SCRIPT = fileURLToPath(new URL("./e2e-web.js", import.meta.url));
const LIVE_SCRIPT = fileURLToPath(new URL("./e2e-live.js", import.meta.url));
const CONSUMER_SCRIPT = fileURLToPath(new URL("./e2e-consumer.js", import.meta.url));
const FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "syndroo-e2e-tools-"));

for (const script of [WEB_SCRIPT, LIVE_SCRIPT, CONSUMER_SCRIPT]) {
  assert.ok(
    existsSync(script),
    `Compiled script missing at ${script}. Run \`npm run build:scripts\` first.`,
  );
}

/**
 * Replaces global fetch so a registry probe never leaves the machine. The
 * status is fixed per run, which is enough to separate "not published" (404)
 * from every other answer.
 */
const FAKE_REGISTRY_MODULE = [
  'import { appendFileSync } from "node:fs";',
  "",
  "const logPath = process.env.FAKE_REGISTRY_LOG;",
  'const status = Number(process.env.FAKE_REGISTRY_STATUS ?? "404");',
  "",
  "globalThis.fetch = async (url) => {",
  "  if (logPath !== undefined && logPath.length > 0) {",
  '    appendFileSync(logPath, String(url) + "\\n");',
  "  }",
  "",
  '  if (status === 0) {',
  '    throw new TypeError("simulated registry network failure");',
  "  }",
  "",
  "  return new Response(null, { status });",
  "};",
  "",
].join("\n");

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown>;
};

function run(
  script: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly preload?: string;
  } = {},
): RunResult {
  const argv =
    options.preload === undefined
      ? [script, ...args]
      : ["--import", pathToFileURL(options.preload).href, script, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: options.cwd ?? FIXTURE_ROOT,
    env: { PATH: process.env["PATH"] ?? "", ...options.env },
    encoding: "utf8",
    timeout: 120_000,
  });

  assert.equal(
    result.error,
    undefined,
    `Failed to start ${script}: ${String(result.error)}`,
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json:
      result.stdout.trim().length === 0
        ? {}
        : (JSON.parse(result.stdout) as Record<string, unknown>),
  };
}

after(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("e2e:web delegation", () => {
  it("refuses to run when the website checkout is missing", async () => {
    const absent = join(FIXTURE_ROOT, "absent");
    const result = run(WEB_SCRIPT, ["--root", absent]);

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /website repository was not found/u);
    assert.equal(result.json["lookedFor"], absent);
  });

  it("refuses a directory that is not the website checkout", async () => {
    const directory = join(FIXTURE_ROOT, "not-web");

    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name: "something-else", version: "1.0.0" }, null, 2)}\n`,
      "utf8",
    );

    const result = run(WEB_SCRIPT, ["--root", directory]);

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /no "build" script/u);
  });

  it("asks for an install instead of running one implicitly", async () => {
    const directory = await createWebFixture("web-no-modules", { nodeModules: false });
    const result = run(WEB_SCRIPT, ["--root", directory]);

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /no node_modules/u);
  });

  it("runs the website build, check, and test in order", async () => {
    const directory = await createWebFixture("web-happy");
    const log = join(directory, "invocations.log");
    const result = run(WEB_SCRIPT, ["--root", directory], { env: { FAKE_WEB_LOG: log } });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readLog(log), ["build", "check", "test"]);
    assert.equal(result.json["project"], null);
    assert.match(result.stderr, /no --project given/u);
  });

  it("omits the unit tests when asked and still records the order", async () => {
    const directory = await createWebFixture("web-skip-tests");
    const log = join(directory, "invocations.log");
    const result = run(WEB_SCRIPT, ["--root", directory, "--skip-tests"], {
      env: { FAKE_WEB_LOG: log },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readLog(log), ["build", "check"]);
  });

  it("stops at the first failing step", async () => {
    const directory = await createWebFixture("web-failing-check");
    const log = join(directory, "invocations.log");
    const result = run(WEB_SCRIPT, ["--root", directory], {
      env: { FAKE_WEB_LOG: log, FAKE_WEB_FAIL: "check" },
    });

    assert.equal(result.status, 1);
    assert.deepEqual(await readLog(log), ["build", "check"]);
    assert.match(String(result.json["error"]), /"check" failed/u);
  });

  it("refuses a browser project when Playwright is not installed", async () => {
    const directory = await createWebFixture("web-no-playwright");
    const result = run(WEB_SCRIPT, ["--root", directory, "--project", "chrome"], {
      env: { FAKE_WEB_LOG: join(directory, "invocations.log") },
    });

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /Playwright is not installed/u);
  });

  it("forwards the project name to Playwright", async () => {
    const directory = await createWebFixture("web-playwright", { playwright: true });
    const log = join(directory, "invocations.log");
    const result = run(WEB_SCRIPT, ["--root", directory, "--project", "chrome"], {
      env: { FAKE_WEB_LOG: log },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readLog(log), [
      "build",
      "check",
      "test",
      "playwright test --project=chrome",
    ]);
    assert.equal(result.json["project"], "chrome");
  });

  it("accepts the documented --project=<name> form", async () => {
    const directory = await createWebFixture("web-playwright-equals", { playwright: true });
    const log = join(directory, "invocations.log");
    const result = run(WEB_SCRIPT, [`--root=${directory}`, "--project=chrome"], {
      env: { FAKE_WEB_LOG: log },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readLog(log), [
      "build",
      "check",
      "test",
      "playwright test --project=chrome",
    ]);
  });
});

describe("e2e:live plan gate", () => {
  it("requires an absolute plan path", async () => {
    assert.equal(run(LIVE_SCRIPT, []).status, 2);

    const relative = run(LIVE_SCRIPT, ["--plan", "plan.json"]);

    assert.equal(relative.status, 2);
    assert.match(String(relative.json["error"]), /absolute path/u);
  });

  it("requires the plan file to exist and to be JSON", async () => {
    const missing = run(LIVE_SCRIPT, ["--plan", join(FIXTURE_ROOT, "absent.json")]);

    assert.equal(missing.status, 2);
    assert.match(String(missing.json["error"]), /could not be read/u);

    const broken = join(FIXTURE_ROOT, "broken.json");

    await writeFile(broken, "{ not json\n", "utf8");

    const invalid = run(LIVE_SCRIPT, ["--plan", broken]);

    assert.equal(invalid.status, 2);
    assert.match(String(invalid.json["error"]), /not valid JSON/u);
  });

  it("lists every missing field at once", async () => {
    const plan = await writePlan("plan-empty", {});
    const result = run(LIVE_SCRIPT, ["--plan", plan]);
    const problems = result.json["problems"] as string[];

    assert.equal(result.status, 2);

    for (const field of [
      "planId",
      "instance",
      "accounts",
      "content",
      "platforms",
      "time",
      "operations",
      "stopConditions",
      "approver",
      "approved",
    ]) {
      assert.ok(
        problems.some((problem) => problem.startsWith(field)),
        `expected a problem for ${field}, saw ${JSON.stringify(problems)}`,
      );
    }
  });

  it("refuses a non-absolute time", async () => {
    const plan = await writePlan("plan-local-time", {
      ...validPlan(),
      time: "2026-10-01T09:00:00",
    });
    const result = run(LIVE_SCRIPT, ["--plan", plan]);

    assert.equal(result.status, 2);
    assert.match(String(result.json["problems"]), /absolute ISO 8601/u);
  });

  it("refuses a plan that is not approved", async () => {
    const plan = await writePlan("plan-unapproved", { ...validPlan(), approved: false });
    const result = run(LIVE_SCRIPT, ["--plan", plan]);

    assert.equal(result.status, 2);
    assert.match(String(result.json["problems"]), /approved must be exactly true/u);
  });

  it("refuses an unknown platform", async () => {
    const plan = await writePlan("plan-unknown-platform", {
      ...validPlan(),
      platforms: ["threads", "carrier-pigeon"],
    });
    const result = run(LIVE_SCRIPT, ["--plan", plan]);

    assert.equal(result.status, 2);
    assert.match(String(result.json["problems"]), /unknown platform/u);
  });

  it("validates without contacting anything and says so", async () => {
    const plan = await writePlan("plan-valid", validPlan());
    const result = run(LIVE_SCRIPT, ["--plan", plan]);

    assert.equal(result.status, 3);
    assert.equal(result.json["ok"], false);
    assert.match(String(result.json["error"]), /only validates unless --execute/u);
    assert.equal(result.json["instance"], "https://staging.example.workers.dev");
  });

  it("requires the separate confirmation before executing", async () => {
    const plan = await writePlan("plan-confirm", validPlan());
    const result = run(LIVE_SCRIPT, ["--plan", plan, "--execute"]);

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /SYNDROO_LIVE_CONFIRM/u);
  });

  it("requires the API key in the environment, never a file", async () => {
    const plan = await writePlan("plan-no-key", validPlan());
    const result = run(LIVE_SCRIPT, ["--plan", plan, "--execute"], {
      env: { SYNDROO_LIVE_CONFIRM: "live-0.4.0-rc.1-001" },
    });

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /SYNDROO_API_KEY must be set/u);
  });

  it("reports a missing CLI binary rather than pretending to run", async () => {
    const plan = await writePlan("plan-no-cli", validPlan());
    const result = run(
      LIVE_SCRIPT,
      ["--plan", plan, "--execute", "--cli", join(FIXTURE_ROOT, "absent-bin.js")],
      {
        env: {
          SYNDROO_LIVE_CONFIRM: "live-0.4.0-rc.1-001",
          SYNDROO_API_KEY: "not-a-real-key",
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /CLI binary was not found/u);
  });

  it("refuses --write without --execute", async () => {
    const plan = await writePlan("plan-write-only", validPlan());
    const result = run(LIVE_SCRIPT, ["--plan", plan, "--write"]);

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /--write requires --execute/u);
  });
});

describe("e2e:consumer source handling", () => {
  it("requires a source", async () => {
    const repository = await createRepositoryFixture("consumer-no-source");
    const result = run(CONSUMER_SCRIPT, [], { cwd: repository });

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /missing --source/u);
  });

  it("rejects an unknown source", async () => {
    const repository = await createRepositoryFixture("consumer-bad-source");
    const result = run(CONSUMER_SCRIPT, ["--source", "ftp"], { cwd: repository });

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /must be "tarball" or "registry"/u);
  });

  it("requires an explicit version for the registry source", async () => {
    const repository = await createRepositoryFixture("consumer-registry-noversion");
    const result = run(CONSUMER_SCRIPT, ["--source", "registry"], { cwd: repository });

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /requires --version/u);
  });

  it("refuses a consumer train whose versions disagree", async () => {
    const repository = await createRepositoryFixture("consumer-mismatch");
    const result = run(CONSUMER_SCRIPT, ["--source", "tarball", "--version", "9.9.9"], {
      cwd: repository,
    });

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /not a consistent consumer train/u);
  });

  it("accepts the --source=<value> form", async () => {
    const repository = await createRepositoryFixture("consumer-equals");
    const result = run(CONSUMER_SCRIPT, ["--source=tarball", "--version=9.9.9"], {
      cwd: repository,
    });

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /not a consistent consumer train/u);
  });

  it("reports a missing registry version as not published", async () => {
    const repository = await createRepositoryFixture("consumer-404");
    const preload = await writeRegistryPreload("consumer-404");
    const log = join(repository, "registry.log");
    const result = run(
      CONSUMER_SCRIPT,
      ["--source", "registry", "--version", "0.4.0-rc.1"],
      {
        cwd: repository,
        preload,
        env: { FAKE_REGISTRY_STATUS: "404", FAKE_REGISTRY_LOG: log },
      },
    );

    assert.equal(result.status, 2);
    assert.match(String(result.json["error"]), /not published: @syndroo\/sdk@0\.4\.0-rc\.1/u);
    // Every package is checked; a 404 does not stop the probe early.
    assert.equal((await readLog(log)).length, 3);
  });

  it("fails closed when the registry returns an error", async () => {
    const repository = await createRepositoryFixture("consumer-500");
    const preload = await writeRegistryPreload("consumer-500");
    const result = run(
      CONSUMER_SCRIPT,
      ["--source", "registry", "--version", "0.4.0-rc.1"],
      {
        cwd: repository,
        preload,
        env: {
          FAKE_REGISTRY_STATUS: "500",
          FAKE_REGISTRY_LOG: join(repository, "registry.log"),
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /registry returned an error/u);
  });

  it("fails closed when the registry call throws", async () => {
    const repository = await createRepositoryFixture("consumer-network");
    const preload = await writeRegistryPreload("consumer-network");
    const result = run(
      CONSUMER_SCRIPT,
      ["--source", "registry", "--version", "0.4.0-rc.1"],
      {
        cwd: repository,
        preload,
        env: {
          FAKE_REGISTRY_STATUS: "0",
          FAKE_REGISTRY_LOG: join(repository, "registry.log"),
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(String(result.json["error"]), /registry returned an error/u);
  });

  it("refuses to install from a real registry without authorization", async () => {
    const repository = await createRepositoryFixture("consumer-published");
    const preload = await writeRegistryPreload("consumer-published");
    const result = run(
      CONSUMER_SCRIPT,
      ["--source", "registry", "--version", "0.4.0-rc.1"],
      {
        cwd: repository,
        preload,
        env: {
          FAKE_REGISTRY_STATUS: "200",
          FAKE_REGISTRY_LOG: join(repository, "registry.log"),
        },
      },
    );

    assert.equal(result.status, 3);
    assert.match(String(result.json["error"]), /not authorized in this environment/u);
  });
});

function validPlan(): Record<string, unknown> {
  return {
    planId: "live-0.4.0-rc.1-001",
    instance: "https://staging.example.workers.dev",
    accounts: ["e2e-test-account.bsky.social"],
    content: "Scheduled acceptance post for the 0.4.0 release candidate.",
    platforms: ["bluesky"],
    time: "2026-10-01T09:00:00+09:00",
    operations: 1,
    stopConditions: ["Stop on the first failed publication."],
    approver: "maintainer@example.invalid",
    approved: true,
  };
}

async function writePlan(name: string, plan: unknown): Promise<string> {
  const path = join(FIXTURE_ROOT, `${name}.json`);

  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return path;
}

async function writeRegistryPreload(name: string): Promise<string> {
  const path = join(FIXTURE_ROOT, `${name}-registry.mjs`);

  await writeFile(path, FAKE_REGISTRY_MODULE, "utf8");

  return path;
}

/**
 * A minimal but real web checkout: `npm run <script>` works and records each
 * invocation, so the delegation order is observable without a network install.
 */
async function createWebFixture(
  name: string,
  options: {
    readonly nodeModules?: boolean;
    readonly playwright?: boolean;
  } = {},
): Promise<string> {
  const directory = join(FIXTURE_ROOT, name);

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "record.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(process.env.FAKE_WEB_LOG, process.argv.slice(2).join(" ") + "\\n");',
      'if (process.env.FAKE_WEB_FAIL === process.argv[2]) { process.exitCode = 1; }',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "syndroo-web-fixture",
        version: "0.0.0",
        private: true,
        scripts: {
          build: "node record.mjs build",
          check: "node record.mjs check",
          test: "node record.mjs test",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (options.nodeModules !== false) {
    await mkdir(join(directory, "node_modules"), { recursive: true });
  }

  if (options.playwright === true) {
    const bin = join(directory, "node_modules", ".bin");

    await mkdir(bin, { recursive: true });
    const path = join(bin, "playwright");

    await writeFile(
      path,
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.env.FAKE_WEB_LOG, "playwright " + process.argv.slice(2).join(" ") + "\\n");',
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(path, 0o755);
  }

  return directory;
}

/**
 * A minimal repository that satisfies the consumer guard, so argument and
 * registry behaviour can be tested without packing anything.
 */
async function createRepositoryFixture(name: string): Promise<string> {
  const directory = join(FIXTURE_ROOT, name);

  await mkdir(join(directory, "packages", "sdk"), { recursive: true });
  await mkdir(join(directory, "packages", "cli"), { recursive: true });
  await mkdir(join(directory, "packages", "cloudflare-worker"), { recursive: true });
  await writeFile(join(directory, "wrangler.jsonc"), "{}\n", "utf8");
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "syndroo", private: true, version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "packages", "sdk", "package.json"),
    `${JSON.stringify({ name: "@syndroo/sdk", version: "0.4.0-rc.1" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "packages", "cli", "package.json"),
    `${JSON.stringify(
      {
        name: "@syndroo/cli",
        version: "0.4.0-rc.1",
        dependencies: { "@syndroo/sdk": "0.4.0-rc.1" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "packages", "cloudflare-worker", "package.json"),
    `${JSON.stringify(
      { name: "@syndroo/cloudflare-worker", version: "0.2.0-rc.1" },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return directory;
}

async function readLog(path: string): Promise<string[]> {
  if (!existsSync(path)) {
    return [];
  }

  return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
}
