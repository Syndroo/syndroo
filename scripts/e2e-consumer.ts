#!/usr/bin/env node
/**
 * Layer 2 consumer gate: install the packed artifacts outside the monorepo and
 * run the real SDK and CLI against the local Mock SNS harness.
 *
 * Two sources are supported.
 *
 * - `tarball` packs this checkout with `npm pack` and installs those tarballs
 *   into a fresh temporary directory. The Syndroo packages come from local
 *   tarballs only; nothing is fetched from a registry for them.
 * - `registry` checks whether the requested version exists on the public
 *   registry. It never installs from a real registry here: a missing version is
 *   reported as "not published", and an existing one is refused unless the
 *   operator explicitly authorizes a registry install on an approved host.
 *
 * `npm link` and relative source paths are deliberately not used: the point of
 * this gate is what a user gets from the published artifacts.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isInside, resolveRepositoryRoot } from "./package-support.js";
import { parseReleaseSet } from "./release-train.js";

const REGISTRY_URL =
  process.env["SYNDROO_CONSUMER_REGISTRY_URL"] ?? "https://registry.npmjs.org";

/** The two packages a user installs to talk to an instance. */
const CONSUMER_PACKAGES = [
  { name: "@syndroo/sdk", directory: "packages/sdk", slug: "sdk" },
  { name: "@syndroo/cli", directory: "packages/cli", slug: "cli" },
] as const;

/** Installed alongside them so the deployable artifact is exercised too. */
const WORKER_PACKAGE = {
  name: "@syndroo/cloudflare-worker",
  directory: "packages/cloudflare-worker",
  slug: "worker",
} as const;

const ALL_PACKAGES = [...CONSUMER_PACKAGES, WORKER_PACKAGE];

type Source = "tarball" | "registry";

type Arguments = {
  readonly source: Source | undefined;
  readonly version: string | undefined;
  readonly keep: boolean;
};

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};

const failures: string[] = [];
const notes: string[] = [];

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));

  if (arguments_.source === undefined) {
    finish(2, {
      error: "missing --source",
      usage:
        "npm run e2e:consumer -- --source tarball|registry [--version <v>] [--keep]",
    });
    return;
  }

  const root = resolveRepositoryRoot(process.cwd());
  const sdk = await readManifest(join(root, CONSUMER_PACKAGES[0].directory, "package.json"));
  const cli = await readManifest(join(root, CONSUMER_PACKAGES[1].directory, "package.json"));
  const worker = await readManifest(join(root, WORKER_PACKAGE.directory, "package.json"));

  let releaseSet;

  try {
    releaseSet = parseReleaseSet(process.env);
  } catch (error) {
    finish(2, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // The 0.6 candidate publishes the CLI alone, so the CLI's own version is the
  // version under test. The historical train keeps the SDK as its anchor.
  const version =
    arguments_.version ?? (releaseSet === "cli" ? cli.version : sdk.version);

  if (releaseSet === "cli") {
    await runCliOnlySource(arguments_.source, version, arguments_.keep, {
      sdk: sdk.version,
      worker: worker.version,
    });
    return;
  }

  if (cli.version !== version) {
    failures.push(
      `@syndroo/cli declares ${cli.version} but the consumer run requested ${version}.`,
    );
  }

  if (worker.version !== version) {
    notes.push(
      `@syndroo/cloudflare-worker is ${worker.version}, not ${version}; the Worker is installed as its own candidate. Make the train uniform before a release.`,
    );
  }

  // The CLI must consume exactly the SDK it ships with; a range would let a
  // consumer install a different SDK than the one under test.
  const declaredRange = cli.dependencies?.["@syndroo/sdk"];

  if (declaredRange !== sdk.version) {
    failures.push(
      `@syndroo/cli must depend on exactly @syndroo/sdk@${sdk.version}; found ${JSON.stringify(declaredRange)}.`,
    );
  }

  if (failures.length > 0) {
    finish(1, { error: "the checkout is not a consistent consumer train", failures });
    return;
  }

  if (arguments_.source === "registry") {
    await runRegistrySource(version);
    return;
  }

  await runTarballSource(root, version, arguments_.keep);
}

/**
 * The self-contained CLI release set.
 *
 * The SDK and the Worker are out of this set: they are neither published nor
 * installed by it, and their versions are reported as context rather than
 * compared. The isolated install itself lives in the dedicated
 * `e2e:cli-local` gate so there is exactly one implementation of it.
 */
async function runCliOnlySource(
  source: Source,
  version: string,
  keep: boolean,
  outOfSet: Readonly<Record<string, string>>,
): Promise<void> {
  const root = resolveRepositoryRoot(process.cwd());

  if (source === "registry") {
    const probe = await probeRegistry(CONSUMER_PACKAGES[1].name, version);

    if (probe === "absent") {
      finish(2, {
        ok: false,
        source: "registry",
        releaseSet: "cli",
        version,
        error: `not published: ${CONSUMER_PACKAGES[1].name}@${version}`,
        outOfSet,
        notes: [
          "A 404 is the only answer that means 'not published'; nothing was installed.",
        ],
      });
      return;
    }

    if (probe !== "published") {
      finish(1, {
        source: "registry",
        releaseSet: "cli",
        version,
        error: "the registry returned an error; this is not a 'not published' answer",
        failures: [`${CONSUMER_PACKAGES[1].name}: ${probe}`],
        outOfSet,
      });
      return;
    }

    finish(3, {
      ok: false,
      source: "registry",
      releaseSet: "cli",
      version,
      error:
        "the version is published, but installing from a real registry is not authorized in this environment",
      outOfSet,
      notes: [
        "Set SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL=true on an approved host to run the registry consumer check.",
        "No install was attempted and no registry credentials were read.",
      ],
    });
    return;
  }

  const gate = resolve(root, ".build", "scripts", "e2e-cli-local.js");

  if (!existsSync(gate)) {
    finish(1, {
      source: "tarball",
      releaseSet: "cli",
      version,
      error: `missing ${gate}; run \`npm run build:scripts\` first`,
      outOfSet,
    });
    return;
  }

  const result = await capture(
    process.execPath,
    [gate],
    root,
    keep
      ? { ...process.env, SYNDROO_CLI_E2E_KEEP: "true" }
      : process.env,
  );
  let payload: unknown;

  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = { stdout: result.stdout.trim().slice(0, 1200) };
  }

  finish(result.status === 0 ? 0 : 1, {
    source: "tarball",
    releaseSet: "cli",
    version,
    outOfSet,
    notes: [
      "only @syndroo/cli was packed and installed; the SDK and Worker are out of this release set",
    ],
    cliLocal: payload,
    stderr: result.stderr.trim().slice(0, 800),
  });
}

async function runTarballSource(
  root: string,
  version: string,
  keep: boolean,
): Promise<void> {
  const artifactParent = resolve(root, ".build", "e2e-consumer");
  await mkdir(artifactParent, { recursive: true });
  const artifactDirectory = await mkdtemp(join(artifactParent, "run-"));

  if (!isInside(root, artifactDirectory)) {
    finish(1, {
      error: `refusing to write artifacts outside the repository (${artifactDirectory})`,
    });
    return;
  }

  const tarballs: Record<string, string> = {};

  for (const definition of ALL_PACKAGES) {
    const tarball = await pack(root, definition.name, artifactDirectory);

    if (tarball === undefined) {
      finish(1, { error: `npm pack failed for ${definition.name}`, failures });
      return;
    }

    tarballs[definition.slug] = tarball;
  }

  notes.push(`tarballs: ${Object.values(tarballs).join(", ")}`);

  const consumerDirectory = await mkdtemp(join(tmpdir(), "syndroo-consumer-"));
  const install = await installTarballs(consumerDirectory, tarballs);

  if (install.status !== 0) {
    await cleanup(consumerDirectory, keep);
    finish(1, {
      error: "the isolated install failed",
      failures: [install.stderr.trim().slice(0, 800)],
      notes,
    });
    return;
  }

  notes.push(
    "installed from local tarballs only; no Syndroo package was fetched from a registry",
  );

  const result = await runConsumerSpec(root, consumerDirectory, {
    source: "tarball",
    version,
  });

  await cleanup(consumerDirectory, keep);
  finish(result.status === 0 ? 0 : 1, {
    ok: result.status === 0,
    source: "tarball",
    version,
    consumerDirectory: keep ? consumerDirectory : null,
    tarballs,
    vitest: {
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    },
    notes,
  });
}

async function runRegistrySource(version: string): Promise<void> {
  const missing: string[] = [];
  const failed: string[] = [];

  for (const definition of ALL_PACKAGES) {
    const probe = await probeRegistry(definition.name, version);

    if (probe === "absent") {
      missing.push(`${definition.name}@${version}`);
      continue;
    }

    if (probe !== "published") {
      failed.push(`${definition.name}: ${probe}`);
    }
  }

  if (failed.length > 0) {
    finish(1, {
      error: "the registry returned an error; this is not a 'not published' answer",
      failures: failed,
    });
    return;
  }

  if (missing.length > 0) {
    finish(2, {
      ok: false,
      source: "registry",
      version,
      error: `not published: ${missing.join(", ")}`,
      notes: [
        "A 404 is the only answer that means 'not published'; nothing was installed.",
      ],
    });
    return;
  }

  if (process.env["SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL"] !== "true") {
    finish(3, {
      ok: false,
      source: "registry",
      version,
      error:
        "every requested version is published, but installing from a real registry is not authorized in this environment",
      notes: [
        "Set SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL=true on an approved host to run the registry consumer check.",
        "No install was attempted and no registry credentials were read.",
      ],
    });
    return;
  }

  const root = resolveRepositoryRoot(process.cwd());
  const consumerDirectory = await mkdtemp(join(tmpdir(), "syndroo-consumer-"));
  const install = await installRegistryPackages(consumerDirectory, version);

  if (install.status !== 0) {
    await cleanup(consumerDirectory, false);
    finish(1, {
      error: "the registry install failed",
      failures: [install.stderr.trim().slice(0, 800)],
    });
    return;
  }

  const result = await runConsumerSpec(root, consumerDirectory, {
    source: "registry",
    version,
  });

  await cleanup(consumerDirectory, false);
  finish(result.status === 0 ? 0 : 1, {
    ok: result.status === 0,
    source: "registry",
    version,
    consumerDirectory: null,
    vitest: {
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    },
    notes,
  });
}

/** Runs the vitest spec that drives the installed packages. */
async function runConsumerSpec(
  root: string,
  consumerDirectory: string,
  context: { readonly source: Source; readonly version: string },
): Promise<RunResult> {
  const vitest = join(root, "node_modules", "vitest", "vitest.mjs");

  if (!existsSync(vitest)) {
    return {
      status: 1,
      stdout: "",
      stderr: `vitest is not installed at ${vitest}; run \`npm ci\` in ${root}.`,
    };
  }

  return await capture(
    process.execPath,
    [vitest, "run", "--config", join(root, "e2e", "vitest.consumer.config.ts")],
    root,
    {
      ...process.env,
      SYNDROO_CONSUMER_DIR: consumerDirectory,
      SYNDROO_CONSUMER_SOURCE: context.source,
      SYNDROO_CONSUMER_VERSION: context.version,
    },
  );
}

async function pack(
  root: string,
  name: string,
  destination: string,
): Promise<string | undefined> {
  const result = await capture(
    "npm",
    ["pack", "--workspace", name, "--pack-destination", destination],
    root,
  );

  if (result.status !== 0) {
    failures.push(`npm pack ${name}: ${result.stderr.trim().slice(0, 400)}`);
    return undefined;
  }

  const fileName = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);

  if (fileName === undefined) {
    failures.push(`npm pack ${name} did not report a tarball`);
    return undefined;
  }

  return join(destination, fileName);
}

/**
 * Installs only local tarballs. `overrides` keeps the CLI's exact SDK
 * dependency pointed at the tarball under test instead of a registry, and
 * `--ignore-scripts` keeps a package install script from running.
 */
async function installTarballs(
  consumerDirectory: string,
  tarballs: Readonly<Record<string, string>>,
): Promise<RunResult> {
  const entry = (slug: string): string => `file:${tarballs[slug] as string}`;

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "syndroo-consumer-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          [CONSUMER_PACKAGES[0].name]: entry("sdk"),
          [CONSUMER_PACKAGES[1].name]: entry("cli"),
          [WORKER_PACKAGE.name]: entry("worker"),
        },
        overrides: {
          [CONSUMER_PACKAGES[0].name]: entry("sdk"),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const attempts: ReadonlyArray<readonly string[]> = [
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--offline",
    ],
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--prefer-offline",
    ],
  ];

  for (const [index, args] of attempts.entries()) {
    const result = await capture("npm", args, consumerDirectory);

    if (result.status === 0) {
      notes.push(
        index === 0
          ? "isolated install used --offline"
          : "isolated install used --prefer-offline (npm cache fallback)",
      );
      return result;
    }

    if (index === attempts.length - 1) {
      return result;
    }
  }

  return { status: 1, stdout: "", stderr: "no install attempt ran" };
}

/** Only reachable with SYNDROO_CONSUMER_ALLOW_REGISTRY_INSTALL=true. */
async function installRegistryPackages(
  consumerDirectory: string,
  version: string,
): Promise<RunResult> {
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "syndroo-consumer-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          ALL_PACKAGES.map((definition) => [definition.name, version]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return await capture(
    "npm",
    ["install", "--no-audit", "--no-fund"],
    consumerDirectory,
  );
}

async function probeRegistry(name: string, version: string): Promise<string> {
  const url = `${REGISTRY_URL}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;

  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });

    if (response.status === 404) {
      return "absent";
    }

    if (!response.ok) {
      return `HTTP ${String(response.status)}`;
    }

    if (response.body !== null) {
      await response.body.cancel();
    }

    return "published";
  } catch (error) {
    return `network failure: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function readManifest(path: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));

  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { name?: unknown }).name !== "string" ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new Error(`${path} is not a package manifest with name and version.`);
  }

  const record = value as {
    name: string;
    version: string;
    dependencies?: Readonly<Record<string, string>>;
  };

  return {
    name: record.name,
    version: record.version,
    ...(record.dependencies === undefined ? {} : { dependencies: record.dependencies }),
  };
}

async function cleanup(directory: string, keep: boolean): Promise<void> {
  if (keep) {
    notes.push(`kept the consumer fixture at ${directory}`);
    return;
  }

  await rm(directory, { recursive: true, force: true });
}

function parseArguments(argv: readonly string[]): Arguments {
  let source: Source | undefined;
  let version: string | undefined;
  let keep = process.env["SYNDROO_CONSUMER_KEEP"] === "true";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--keep") {
      keep = true;
      continue;
    }

    if (token === "--source" || token === "--version") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error(`${token} requires a value.`);
      }

      if (token === "--source") {
        if (value !== "tarball" && value !== "registry") {
          throw new Error(
            `--source must be "tarball" or "registry", received ${JSON.stringify(value)}.`,
          );
        }

        source = value;
      } else {
        version = value;
      }

      index += 1;
      continue;
    }

    // Accept `--source=tarball` and `--version=0.4.0-rc.1` as well.
    if (token.startsWith("--source=") || token.startsWith("--version=")) {
      const separator = token.indexOf("=");
      const name = token.slice(0, separator);
      const value = token.slice(separator + 1);

      if (value.length === 0) {
        throw new Error(`${name} requires a value.`);
      }

      if (name === "--source") {
        if (value !== "tarball" && value !== "registry") {
          throw new Error(
            `--source must be "tarball" or "registry", received ${JSON.stringify(value)}.`,
          );
        }

        source = value;
      } else {
        version = value;
      }

      continue;
    }

    throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
  }

  if (source === "registry" && version === undefined) {
    throw new Error(
      "--source registry requires --version so the exact published version is checked.",
    );
  }

  return { source, version, keep };
}

function finish(exitCode: number, payload: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ ok: exitCode === 0, exitCode, ...payload }, null, 2));

  // A failing exit is an outcome, not a crash: the report above is the evidence.
  process.exitCode = exitCode;
}

/** Captures a child process with a bounded run time. */
async function capture(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  return await new Promise<RunResult>((settle) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n${command} did not exit within 10 minutes`;
    }, 10 * 60 * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      settle({ status: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      settle({ status: code, stdout, stderr });
    });
  });
}

try {
  await main();
} catch (error) {
  finish(2, { error: error instanceof Error ? error.message : String(error) });
}
