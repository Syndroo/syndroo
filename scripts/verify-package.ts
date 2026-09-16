#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  collectBundledSources,
  findTextViolations,
  isInside,
  PACKAGE_NAME,
  PACKAGE_PATH,
  planWorkerBundle,
  resolveRepositoryRoot,
  sourceFileCandidates,
  type Violation,
} from "./package-support.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
const EXPECTED_MIGRATIONS = [
  "0001_init.sql",
  "0002_idempotency.sql",
  "0003_retry_timing.sql",
] as const;
const REQUIRED_PACKED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "licenses/third-party-license-supplements.json",
  "licenses/mit.txt",
  "types/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/deploy.js",
  "dist/THIRD_PARTY_LICENSES.txt",
  ...EXPECTED_MIGRATIONS.map((name) => `migrations/${name}`),
] as const;
const FORBIDDEN_PACKED_PREFIXES = [
  "node_modules/",
  "experiments/",
  "e2e/",
  "test/",
  "src/",
  "scripts/",
] as const;
const FORBIDDEN_PACKED_NAMES = [
  ".dev.vars",
  "wrangler.jsonc",
  "package-lock.json",
] as const;
const FORBIDDEN_PACKED_PATHS = ["dist/README.md"] as const;
const REQUIRED_HANDLERS = ["fetch", "scheduled", "queue"] as const;
// Every adapter and the shared core must be present in the bundle, so a
// Bluesky-only or otherwise partial Worker cannot ship as the candidate.
const REQUIRED_BUNDLE_SOURCES = [
  "packages/core/src/index.ts",
  "packages/bluesky/src/index.ts",
  "packages/threads/src/index.ts",
  "packages/x/src/index.ts",
  "packages/tumblr/src/index.ts",
  "packages/linkedin/src/index.ts",
  "packages/cloudflare-worker/src/index.ts",
] as const;
const REQUIRED_BUNDLED_PACKAGES = [
  "twitter-text",
  "@xdevplatform/xdk",
  "@atproto/api",
] as const;

const failures: Violation[] = [];
const notes: string[] = [];

const repositoryRoot = resolveRepositoryRoot(process.cwd());
const plan = planWorkerBundle(repositoryRoot);
const packageDirectory = resolve(repositoryRoot, PACKAGE_PATH);
const manifestPath = resolve(packageDirectory, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackedManifest;
// The public manifest stays the single release version source. The environment
// variable only lets a release run assert that the candidate it reviewed is the
// candidate it is about to publish.
const expectedVersion =
  process.env["SYNDROO_EXPECT_PACKAGE_VERSION"] ?? manifest.version ?? "";

// Build evidence stays inside the gitignored `.build/` directory so it can be
// inspected. The isolated install fixture is created outside the repository so
// module resolution can never fall back to the checkout's node_modules.
//
// The evidence parent is only ever used as a container: each run creates and
// reports its own `candidate-*` child, and no caller-controlled path is ever
// removed recursively.
const artifactDirectoryOverride = process.env["SYNDROO_PACKAGE_ARTIFACT_DIR"];
const artifactParent =
  artifactDirectoryOverride === undefined || artifactDirectoryOverride.length === 0
    ? resolve(repositoryRoot, ".build", "package-candidate")
    : resolve(artifactDirectoryOverride);
await mkdir(artifactParent, { recursive: true });
const artifactDirectory = await mkdtemp(join(artifactParent, "candidate-"));
const fixtureDirectory = await mkdtemp(join(tmpdir(), "syndroo-package-fixture-"));

let tarballPath: string | undefined;

try {
  checkManifest(manifest, expectedVersion);
  await checkBuiltArtifacts();

  if (failures.length === 0) {
    tarballPath = await packPackage();
    await checkTarball(tarballPath);
    await installTarball(tarballPath);
    await checkInstalledFiles();
    await checkWorkerImport();
    await checkTypes();
    await checkDeployCommand("existing-database");
    await checkDeployCommand("missing-database");
  }
} catch (error) {
  record(
    "verify-crashed",
    error instanceof Error ? error.message : String(error),
  );
} finally {
  // The fixture is disposable; set SYNDROO_KEEP_PACKAGE_FIXTURE=true to keep it
  // for debugging a failing run.
  const keepFixture = process.env["SYNDROO_KEEP_PACKAGE_FIXTURE"] === "true";

  if (!keepFixture) {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }

  report();
}

type PackedManifest = {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly files?: readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly repository?: { readonly url?: string };
  readonly bin?: Record<string, string>;
};

type RunResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function record(code: string, detail: string): void {
  failures.push({ code, detail });
}

function recordUnless(condition: boolean, code: string, detail: string): void {
  if (!condition) {
    record(code, detail);
  }
}

function checkManifest(current: PackedManifest, expected: string): void {
  recordUnless(
    current.name === PACKAGE_NAME,
    "manifest-name",
    `Unexpected package name ${JSON.stringify(current.name)}.`,
  );
  recordUnless(
    typeof current.version === "string" && VERSION_PATTERN.test(current.version),
    "manifest-version-shape",
    `Package version ${JSON.stringify(current.version)} must be <x.y.z> or <x.y.z-rc.n>.`,
  );
  recordUnless(
    current.version === expected,
    "manifest-version",
    `Expected version ${expected}; the manifest declares ${JSON.stringify(current.version)}.`,
  );
  recordUnless(
    current.license === "Apache-2.0",
    "manifest-license",
    "Package license must be Apache-2.0.",
  );
  recordUnless(
    current.repository?.url === "git+https://github.com/Syndroo/syndroo.git",
    "manifest-repository",
    "Package repository URL does not match Syndroo/syndroo.",
  );

  for (const required of [
    "dist",
    "licenses",
    "migrations",
    "types",
    "LICENSE",
    "NOTICE",
    "README.md",
  ]) {
    recordUnless(
      Array.isArray(current.files) && current.files.includes(required),
      "manifest-files",
      `Package "files" must include ${JSON.stringify(required)}.`,
    );
  }

  for (const [name, range] of Object.entries(current.dependencies ?? {})) {
    recordUnless(
      !range.startsWith("workspace:"),
      "manifest-workspace-dependency",
      `Dependency ${name} uses the workspace protocol (${range}).`,
    );
    recordUnless(
      !name.startsWith("@syndroo/"),
      "manifest-internal-dependency",
      `Runtime dependency ${name} is a private workspace package.`,
    );
  }

  for (const [name, range] of Object.entries(current.devDependencies ?? {})) {
    recordUnless(
      !range.startsWith("workspace:"),
      "manifest-workspace-devdependency",
      `Dev dependency ${name} uses the workspace protocol (${range}).`,
    );
  }

  recordUnless(
    current.bin?.["syndroo-deploy"] === "./dist/deploy.js",
    "manifest-bin",
    "The syndroo-deploy bin must point at ./dist/deploy.js.",
  );
}

async function checkBuiltArtifacts(): Promise<void> {
  const artifacts = [
    resolve(plan.outputDirectory, "index.js"),
    resolve(plan.outputDirectory, "index.js.map"),
    resolve(plan.outputDirectory, "deploy.js"),
    resolve(plan.outputDirectory, "THIRD_PARTY_LICENSES.txt"),
  ];

  for (const artifact of artifacts) {
    if (!existsSync(artifact)) {
      record(
        "artifact-missing",
        `Missing build artifact ${artifact}. Run \`npm run build:package\`.`,
      );
      continue;
    }

    const info = await stat(artifact);
    recordUnless(
      info.size > 0,
      "artifact-empty",
      `Build artifact ${basename(artifact)} is empty.`,
    );
  }

  // Stop before touching the filesystem further: a missing bundle would only
  // produce cascading errors in the later steps.
  if (failures.length > 0) {
    return;
  }

  const newest = await newestInput(repositoryRoot);

  for (const artifact of artifacts.slice(0, 3)) {
    const info = await stat(artifact);
    recordUnless(
      info.mtimeMs >= newest.mtimeMs,
      "artifact-stale",
      `${basename(artifact)} is older than ${newest.path}; rebuild before packing.`,
    );
  }

  const sourceMap: unknown = JSON.parse(
    await readFile(resolve(plan.outputDirectory, "index.js.map"), "utf8"),
  );
  const mapRecord = sourceMap as { sources?: unknown; sourceRoot?: unknown };
  const relativeSources = mapRecord.sources;
  const sourceRoot =
    typeof mapRecord.sourceRoot === "string" ? mapRecord.sourceRoot : undefined;

  if (Array.isArray(relativeSources)) {
    const sourceNames = relativeSources.filter(
      (source): source is string => typeof source === "string",
    );
    // Source map paths are relative to the bundle directory, so each required
    // workspace module is compared as a resolved path rather than a suffix.
    const bundledPaths = new Set(
      sourceNames.flatMap((source) =>
        sourceFileCandidates(plan.outputDirectory, sourceRoot, source),
      ),
    );

    for (const required of REQUIRED_BUNDLE_SOURCES) {
      recordUnless(
        bundledPaths.has(resolve(repositoryRoot, required)),
        "bundle-incomplete",
        `The bundle does not include ${required}; the published Worker would be partial.`,
      );
    }
  }

  const { sources } = collectBundledSources(sourceMap, plan.outputDirectory);
  const bundled = [...new Set(sources.map((entry) => entry.packageName))].sort();

  for (const required of REQUIRED_BUNDLED_PACKAGES) {
    recordUnless(
      bundled.includes(required),
      "bundle-incomplete",
      `The bundle does not include ${required}.`,
    );
  }

  notes.push(`bundled third-party packages: ${String(bundled.length)}`);
}

async function newestInput(
  root: string,
): Promise<{ path: string; mtimeMs: number }> {
  const inputs: string[] = [
    resolve(root, "wrangler.jsonc"),
    resolve(root, "tsconfig.base.json"),
    resolve(root, "scripts", "deploy.ts"),
    resolve(root, PACKAGE_PATH, "tsconfig.deploy.json"),
    resolve(root, PACKAGE_PATH, "package.json"),
  ];
  const packagesDirectory = resolve(root, "packages");

  for (const workspace of await readdir(packagesDirectory)) {
    const sourceDirectory = resolve(packagesDirectory, workspace, "src");

    if (existsSync(sourceDirectory)) {
      inputs.push(...(await listFilesRecursively(sourceDirectory)));
    }
  }

  let newest = { path: "", mtimeMs: 0 };

  for (const input of inputs) {
    if (!existsSync(input)) {
      continue;
    }

    const info = await stat(input);

    if (info.mtimeMs > newest.mtimeMs) {
      newest = { path: input, mtimeMs: info.mtimeMs };
    }
  }

  return newest;
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const found: string[] = [];

  for (const name of await readdir(directory)) {
    const target = resolve(directory, name);
    const info = await stat(target);

    if (info.isDirectory()) {
      found.push(...(await listFilesRecursively(target)));
      continue;
    }

    found.push(target);
  }

  return found;
}

async function packPackage(): Promise<string> {
  const result = run(
    "npm",
    [
      "pack",
      "--workspace",
      PACKAGE_NAME,
      "--pack-destination",
      artifactDirectory,
    ],
    repositoryRoot,
  );

  recordUnless(
    result.status === 0,
    "pack-failed",
    `npm pack failed: ${firstLines(result.stderr)}`,
  );

  // `npm pack` runs the package `prepack` script, so the archived bundle is
  // rebuilt from the current sources before the tarball is written.
  const tarballPath = resolve(
    artifactDirectory,
    `${PACKAGE_NAME.replace("@", "").replace("/", "-")}-${manifest.version ?? "unknown"}.tgz`,
  );

  recordUnless(
    existsSync(tarballPath),
    "pack-missing-tarball",
    `Expected tarball ${tarballPath}.`,
  );
  notes.push(`tarball: ${tarballPath}`);

  return tarballPath;
}

async function checkTarball(tarballPath: string): Promise<void> {
  if (!existsSync(tarballPath)) {
    return;
  }

  const listing = run("tar", ["-tzf", tarballPath], repositoryRoot);

  if (listing.status !== 0) {
    record(
      "tar-list-failed",
      `Could not list the tarball: ${firstLines(listing.stderr)}`,
    );
    return;
  }

  const fileNames = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package/"))
    .map((line) => line.slice("package/".length))
    .filter((line) => line.length > 0 && !line.endsWith("/"));

  for (const required of REQUIRED_PACKED_FILES) {
    recordUnless(
      fileNames.includes(required),
      "pack-missing-file",
      `The package is missing ${required}.`,
    );
  }

  for (const name of fileNames) {
    for (const prefix of FORBIDDEN_PACKED_PREFIXES) {
      if (name.startsWith(prefix)) {
        record("pack-forbidden-path", `The package must not contain ${name}.`);
      }
    }

    for (const forbidden of FORBIDDEN_PACKED_NAMES) {
      if (basename(name) === forbidden) {
        record("pack-forbidden-file", `The package must not contain ${name}.`);
      }
    }

    if (FORBIDDEN_PACKED_PATHS.includes(name as (typeof FORBIDDEN_PACKED_PATHS)[number])) {
      record("pack-forbidden-file", `The package must not contain ${name}.`);
    }
  }

  const extracted = resolve(artifactDirectory, "extracted");
  await mkdir(extracted, { recursive: true });

  const extraction = run(
    "tar",
    ["-xzf", tarballPath, "-C", extracted],
    repositoryRoot,
  );

  if (extraction.status !== 0) {
    record(
      "tar-extract-failed",
      `Could not extract the tarball: ${firstLines(extraction.stderr)}`,
    );
    return;
  }

  const packedDirectory = resolve(extracted, "package");
  const packedManifest = JSON.parse(
    await readFile(resolve(packedDirectory, "package.json"), "utf8"),
  ) as PackedManifest;

  recordUnless(
    packedManifest.version === expectedVersion,
    "pack-version",
    `Packed manifest carries ${JSON.stringify(packedManifest.version)}, expected ${expectedVersion}.`,
  );

  await scanForLeaks(packedDirectory);

  const migrationNames = (await readdir(resolve(packedDirectory, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  recordUnless(
    migrationNames.join(",") === [...EXPECTED_MIGRATIONS].join(","),
    "pack-migrations",
    `Expected migrations ${EXPECTED_MIGRATIONS.join(", ")}; found ${migrationNames.join(", ") || "none"}.`,
  );
}

async function scanForLeaks(directory: string): Promise<void> {
  for (const path of await listFilesRecursively(directory)) {
    const info = await stat(path);

    if (info.size > 8 * 1024 * 1024) {
      continue;
    }

    const contents = await readFile(path, "utf8");
    const relative = path.slice(directory.length + 1);

    for (const violation of findTextViolations(contents, relative)) {
      record(violation.code, violation.detail);
    }
  }
}

async function installTarball(tarballPath: string): Promise<void> {
  await writeFile(
    resolve(fixtureDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "syndroo-package-verify",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // A real deployment installs the Cloudflare runtime types next to the
  // package. Installing the pinned dev copy here keeps the isolated consumer
  // close to that setup; `--no-save` leaves the fixture manifest untouched.
  const workersTypesVersion = await readInstalledWorkersTypesVersion();
  const extraPackages =
    workersTypesVersion === undefined
      ? []
      : [`@cloudflare/workers-types@${workersTypesVersion}`];

  const attempts: ReadonlyArray<readonly string[]> = [
    [
      "install",
      tarballPath,
      ...extraPackages,
      "--no-save",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    [
      "install",
      tarballPath,
      ...extraPackages,
      "--no-save",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
  ];

  for (const [index, args] of attempts.entries()) {
    const result = run("npm", args, fixtureDirectory);

    if (result.status === 0) {
      notes.push(
        index === 0
          ? "isolated install used --offline (no registry fetch)"
          : "isolated install used --prefer-offline (npm cache fallback)",
      );
      return;
    }

    if (index === attempts.length - 1) {
      record(
        "install-failed",
        `Isolated install failed: ${firstLines(result.stderr)}`,
      );
    }
  }
}

async function readInstalledWorkersTypesVersion(): Promise<string | undefined> {
  const manifestPath = resolve(
    repositoryRoot,
    "node_modules",
    "@cloudflare",
    "workers-types",
    "package.json",
  );

  if (!existsSync(manifestPath)) {
    return undefined;
  }

  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));

  return typeof (value as { version?: unknown }).version === "string"
    ? (value as { version: string }).version
    : undefined;
}

async function checkInstalledFiles(): Promise<void> {
  const installed = resolve(fixtureDirectory, "node_modules", PACKAGE_NAME);

  if (!existsSync(installed)) {
    record(
      "install-missing-package",
      `Installed package missing at ${installed}.`,
    );
    return;
  }

  for (const required of REQUIRED_PACKED_FILES) {
    recordUnless(
      existsSync(resolve(installed, required)),
      "install-missing-file",
      `Installed package is missing ${required}.`,
    );
  }

  recordUnless(
    existsSync(
      resolve(fixtureDirectory, "node_modules", ".bin", "syndroo-deploy"),
    ),
    "install-missing-bin",
    "The syndroo-deploy bin was not linked in the isolated install.",
  );

  const migrationNames = (await readdir(resolve(installed, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  recordUnless(
    migrationNames.join(",") === [...EXPECTED_MIGRATIONS].join(","),
    "install-migrations",
    `Installed migrations differ: ${migrationNames.join(", ")}.`,
  );
}

async function checkWorkerImport(): Promise<void> {
  const script = [
    `const module = await import(${JSON.stringify(PACKAGE_NAME)});`,
    "const worker = module.default;",
    `const missing = ${JSON.stringify(REQUIRED_HANDLERS)}.filter((name) => typeof worker?.[name] !== "function");`,
    "if (missing.length > 0) {",
    '  throw new Error(`Worker is missing handlers: ${missing.join(", ")}`);',
    "}",
    `console.log(JSON.stringify({ exports: Object.keys(module).sort(), handlers: ${JSON.stringify(REQUIRED_HANDLERS)} }));`,
  ].join("\n");

  const result = run(
    "node",
    ["--input-type=module", "--eval", script],
    fixtureDirectory,
  );
  recordUnless(
    result.status === 0,
    "worker-import-failed",
    `Importing the installed Worker failed: ${firstLines(result.stderr)}`,
  );

  if (result.status === 0) {
    notes.push(`worker import: ${result.stdout.trim()}`);
  }
}

async function checkTypes(): Promise<void> {
  // The package does not ship Cloudflare runtime types: a real deployment
  // provides them. The fixture therefore type-checks a consumer entry point
  // against the Wrangler-generated globals from this checkout.
  await cp(
    resolve(packageDirectory, "worker-configuration.d.ts"),
    resolve(fixtureDirectory, "worker-configuration.d.ts"),
  );
  await mkdir(resolve(fixtureDirectory, "src"), { recursive: true });
  await writeFile(
    resolve(fixtureDirectory, "src", "index.ts"),
    [
      `import worker from ${JSON.stringify(PACKAGE_NAME)};`,
      "",
      "const handler: ExportedHandler<Env> = worker;",
      "const fetchHandler: ExportedHandlerFetchHandler<Env> | undefined = handler.fetch;",
      "type IsAny<T> = 0 extends 1 & T ? true : false;",
      "// Guards against the shipped declaration collapsing to `any`.",
      "const workerIsTyped: IsAny<typeof worker> extends false ? true : never = true;",
      "",
      "export { fetchHandler, workerIsTyped };",
      "export default handler;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    resolve(fixtureDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          strict: true,
          noEmit: true,
          // Matches the repository's own setting: the Wrangler-generated
          // globals are checked by `npm run check`, not by this consumer.
          skipLibCheck: true,
        },
        include: ["src/index.ts", "worker-configuration.d.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = run(
    process.execPath,
    [
      resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      resolve(fixtureDirectory, "tsconfig.json"),
    ],
    fixtureDirectory,
  );

  recordUnless(
    result.status === 0,
    "types-check-failed",
    `Type-checking the installed package failed: ${firstLines(result.stdout + result.stderr)}`,
  );

  // Separate probe: the isolated install must also resolve the Cloudflare
  // runtime types the way a deployment template does.
  await writeFile(
    resolve(fixtureDirectory, "workers-types-probe.ts"),
    [
      'import type { D1Database as WorkersD1Database } from "@cloudflare/workers-types/experimental";',
      "",
      "declare const database: WorkersD1Database;",
      "",
      "export { database };",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    resolve(fixtureDirectory, "tsconfig.workers-types.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          // Bundler resolution is what vitest and tsup consumers use, and it is
          // the mode that resolves the `experimental` subpath the package
          // publishes without an exports map.
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022"],
          strict: true,
          noEmit: true,
        },
        include: ["workers-types-probe.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const probe = run(
    process.execPath,
    [
      resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      resolve(fixtureDirectory, "tsconfig.workers-types.json"),
    ],
    fixtureDirectory,
  );

  recordUnless(
    probe.status === 0,
    "workers-types-check-failed",
    `@cloudflare/workers-types did not resolve in the isolated install: ${firstLines(probe.stdout + probe.stderr)}`,
  );
}

async function checkDeployCommand(
  scenario: "existing-database" | "missing-database",
): Promise<void> {
  const database = {
    name: "syndroo",
    uuid: "11111111-2222-3333-4444-555555555555",
  };
  const fakeBin = resolve(artifactDirectory, "fake-bin");
  const statePath = resolve(artifactDirectory, `${scenario}-state.json`);
  const logPath = resolve(artifactDirectory, `${scenario}-wrangler.log`);
  await mkdir(fakeBin, { recursive: true });
  await rm(logPath, { force: true });

  // `existing-database` starts with the database already listed, so the deploy
  // script must never create one.
  if (scenario === "existing-database") {
    await writeFile(statePath, JSON.stringify([database]), "utf8");
  } else {
    await rm(statePath, { force: true });
  }

  const fakeWranglerPath = resolve(fakeBin, "wrangler");
  await writeFile(fakeWranglerPath, fakeWranglerSource(), "utf8");
  await chmod(fakeWranglerPath, 0o755);

  await writeFile(
    resolve(fixtureDirectory, "wrangler.jsonc"),
    `${JSON.stringify(
      {
        name: "syndroo-fixture",
        main: "src/index.ts",
        d1_databases: [{ binding: "DB", database_name: "syndroo" }],
        queues: {
          producers: [
            { binding: "PUBLICATION_QUEUE", queue: "syndroo-publications" },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const deployConfigPath = resolve(fixtureDirectory, ".wrangler.deploy.jsonc");
  await rm(deployConfigPath, { force: true });

  const result = run(
    resolve(fixtureDirectory, "node_modules", ".bin", "syndroo-deploy"),
    [],
    fixtureDirectory,
    {
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      FAKE_WRANGLER_LOG: logPath,
      FAKE_WRANGLER_STATE: statePath,
      FAKE_WRANGLER_DATABASE: JSON.stringify(database),
    },
  );

  recordUnless(
    result.status === 0,
    "deploy-failed",
    `syndroo-deploy (${scenario}) failed: ${firstLines(result.stdout + result.stderr)}`,
  );

  if (!existsSync(logPath)) {
    record(
      "deploy-no-wrangler-calls",
      `syndroo-deploy (${scenario}) never invoked the wrangler CLI.`,
    );
    return;
  }

  const calls = (await readFile(logPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const signature = calls.map((call) => argSignature(call["args"]));
  const expected = expectedWranglerCalls(scenario);

  recordUnless(
    signature.join(" | ") === expected.join(" | "),
    "deploy-order",
    `syndroo-deploy (${scenario}) called wrangler as [${signature.join(" | ")}]; expected [${expected.join(" | ")}].`,
  );

  for (const call of calls) {
    const args = argsOf(call["args"]);

    if (args.includes("--config")) {
      recordUnless(
        call["configExists"] === true,
        "deploy-config-missing",
        `syndroo-deploy (${scenario}) passed a --config path that did not exist.`,
      );
      continue;
    }

    recordUnless(
      !args.includes(deployConfigPath),
      "deploy-config-leak",
      "wrangler was called with the temporary config outside --config.",
    );
  }

  const lastCall = calls.at(-1);

  if (lastCall !== undefined) {
    recordUnless(
      String(lastCall["configText"] ?? "").includes(database.uuid),
      "deploy-config-content",
      `The temporary deploy config (${scenario}) does not carry the resolved D1 database id.`,
    );
  }

  recordUnless(
    !existsSync(deployConfigPath),
    "deploy-cleanup",
    `syndroo-deploy (${scenario}) left ${deployConfigPath} behind.`,
  );

  notes.push(`syndroo-deploy (${scenario}) calls: ${signature.join(" | ")}`);
}

function argsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function argSignature(value: unknown): string {
  const args = argsOf(value);
  const index = args.indexOf("--config");

  if (index < 0) {
    return args.join(" ");
  }

  const copy = [...args];
  copy[index + 1] = "<temp>";

  return copy.join(" ");
}

function expectedWranglerCalls(
  scenario: "existing-database" | "missing-database",
): string[] {
  const calls = ["d1 list --json"];

  if (scenario === "missing-database") {
    calls.push("d1 create syndroo", "d1 list --json");
  }

  calls.push(
    "d1 migrations apply DB --remote --config <temp>",
    "deploy --config <temp>",
  );

  return calls;
}

function fakeWranglerSource(): string {
  return [
    "#!/usr/bin/env node",
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    "",
    "const args = process.argv.slice(2);",
    'const configIndex = args.indexOf("--config");',
    "const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;",
    "const record = { args };",
    "",
    "if (configPath !== undefined) {",
    "  record.configExists = existsSync(configPath);",
    '  record.configText = record.configExists ? readFileSync(configPath, "utf8") : "";',
    "}",
    "",
    "const statePath = process.env.FAKE_WRANGLER_STATE;",
    'const database = JSON.parse(process.env.FAKE_WRANGLER_DATABASE ?? "{}");',
    'const command = args.slice(0, 2).join(" ");',
    "",
    'if (command === "d1 create" && statePath !== undefined) {',
    "  writeFileSync(statePath, JSON.stringify([database]));",
    "}",
    "",
    'if (command === "d1 list") {',
    '  const state = statePath !== undefined && existsSync(statePath) ? readFileSync(statePath, "utf8") : "[]";',
    "  process.stdout.write(state);",
    "}",
    "",
    'appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(record) + "\\n");',
    "",
  ].join("\n");
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): RunResult {
  // Commands only ever run inside the checkout or inside this run's own
  // temporary fixture directory.
  if (!isInside(repositoryRoot, cwd) && !isInside(fixtureDirectory, cwd)) {
    record(
      "unexpected-cwd",
      `Refusing to run ${command} outside the repository (${cwd}).`,
    );

    return { status: 1, stdout: "", stderr: "unexpected cwd" };
  }

  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ??
      (result.error === undefined ? "" : String(result.error.message)),
  };
}

function firstLines(text: string): string {
  return text.trim().split("\n").slice(0, 6).join(" ");
}

function report(): void {
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        package: PACKAGE_NAME,
        version: manifest.version,
        expectedVersion,
        tarball: tarballPath ?? null,
        artifactDirectory,
        fixtureDirectory: existsSync(fixtureDirectory) ? fixtureDirectory : null,
        notes,
        failures,
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
