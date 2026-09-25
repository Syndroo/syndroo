#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CLI_PACKAGE_NAME,
  cliArtifactFileName,
  npmBinary,
  packCliArtifact,
  readCliVersion,
  runCommand,
  type PackedCli,
} from "./cli-support.js";
import { resolveRepositoryRoot } from "./package-support.js";

/**
 * Isolated consumer gate for the self-contained CLI candidate.
 *
 * The tarball is installed into a throwaway directory outside the repository
 * with a blank HOME and an empty NODE_PATH, so no workspace symlink, hoisted
 * dependency, or developer shell setting can make an unpublished package
 * resolve. What passes here is what a real `npm install` gets.
 *
 * Every check is a real assertion. A missing or broken command surface fails
 * this gate; nothing is downgraded to "pending". The execute/replay part runs
 * the packaged library entry point through `cli-consumer-driver.ts`, which
 * supplies fake providers in-process, so no fake endpoint is shipped.
 */

const repositoryRoot = resolveRepositoryRoot(process.cwd());
const version = await readCliVersion(repositoryRoot);
const failures: string[] = [];
const notes: string[] = [];
const checks: Record<string, string> = {};

/**
 * By default the gate builds its own artifact, so CI always tests what the
 * current source produces. `SYNDROO_CLI_ARTIFACT` lets a matrix run reuse one
 * already-packed tarball, which keeps every runtime leg pointed at the same
 * bytes instead of repacking (and rebuilding `dist/`) between legs.
 *
 * Only an *unset* variable selects the default pack. A supplied value that is
 * empty, missing, not a file, or empty on disk fails closed: silently packing
 * instead would test different bytes than the caller asked for, which is
 * exactly the mistake the option exists to prevent.
 */
/** Assigned once an artifact has been selected; read by the checks below. */
let packed: PackedCli;
let home = "";
let app = "";

const artifactSelection = await selectArtifact(
  process.env["SYNDROO_CLI_ARTIFACT"],
);

if (artifactSelection.packed === undefined) {
  fail(artifactSelection.detail);
  report();
} else {
  packed = artifactSelection.packed;

  await runGate();
  report();
}

function report(): void {
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        package: CLI_PACKAGE_NAME,
        version,
        artifact: cliArtifactFileName(version),
        artifactSource:
          process.env["SYNDROO_CLI_ARTIFACT"] === undefined
            ? "built by this run"
            : "supplied by SYNDROO_CLI_ARTIFACT",
        sha256: selectedArtifact()?.sha256 ?? null,
        bytes: selectedArtifact()?.bytes ?? null,
        files: selectedArtifact()?.files.length ?? null,
        runtime: `node ${process.versions.node} ${process.platform} ${process.arch}`,
        checks,
        failures,
        notes,
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

/** The selected artifact, or `undefined` when selection failed closed. */
function selectedArtifact(): PackedCli | undefined {
  return packed;
}

/** An artifact to test, or the reason the supplied one cannot be used. */
async function selectArtifact(
  raw: string | undefined,
): Promise<
  | { readonly packed: PackedCli; readonly detail?: undefined }
  | { readonly packed: undefined; readonly detail: string }
> {
  if (raw === undefined) {
    return { packed: await packCliArtifact(repositoryRoot) };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return {
      packed: undefined,
      detail:
        "SYNDROO_CLI_ARTIFACT is set but empty; unset it to build the artifact, or point it at a tarball",
    };
  }

  const absolute = resolve(trimmed);

  if (!existsSync(absolute)) {
    return {
      packed: undefined,
      detail: `SYNDROO_CLI_ARTIFACT points at a missing file: ${absolute}`,
    };
  }

  const stats = await stat(absolute);

  if (!stats.isFile()) {
    return {
      packed: undefined,
      detail: `SYNDROO_CLI_ARTIFACT is not a file: ${absolute}`,
    };
  }

  if (stats.size === 0) {
    return {
      packed: undefined,
      detail: `SYNDROO_CLI_ARTIFACT is an empty file: ${absolute}`,
    };
  }

  return { packed: await describeExistingArtifact(absolute) };
}

async function runGate(): Promise<void> {
  const consumerRoot = await mkdtemp(join(tmpdir(), "syndroo-cli-consumer-"));

  home = join(consumerRoot, "home");
  app = join(consumerRoot, "app");

  try {
  await mkdir(home, { recursive: true });
  await mkdir(app, { recursive: true });

  const environment: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    NODE_PATH: "",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
    npm_config_cache: join(home, ".npm"),
  };

  await writeConsumerManifest();
  await checkTarballContents();
  await installTarball(environment);
  await checkInstalledTree();
  await checkCommand(environment);
  await checkLibraryImport(environment);
  await checkDeclarations(environment);
  await checkLocalWorkflow(environment);
} finally {
  if (process.env["SYNDROO_CLI_E2E_KEEP"] !== "true") {
    await rm(consumerRoot, { recursive: true, force: true });
  } else {
    notes.push(`consumer directory kept at ${consumerRoot}`);
  }
}
}

function fail(detail: string): void {
  failures.push(detail);
}

/** Reads a tarball that was packed by an earlier step, without repacking it. */
async function describeExistingArtifact(tarballPath: string): Promise<PackedCli> {
  const bytes = await readFile(tarballPath);
  const { createHash } = await import("node:crypto");
  const { stat } = await import("node:fs/promises");
  const listed = await runCommand(
    npmBinary(),
    ["pack", tarballPath, "--dry-run", "--json"],
    { cwd: repositoryRoot },
  );
  let files: string[] = [];

  try {
    const parsed = JSON.parse(listed.stdout) as ReadonlyArray<{ files?: unknown }>;
    const entries = parsed[0]?.files;

    if (Array.isArray(entries)) {
      files = entries
        .map((entry) =>
          typeof entry === "object" && entry !== null && "path" in entry
            ? String((entry as { path: unknown }).path)
            : undefined,
        )
        .filter((path): path is string => path !== undefined)
        .sort();
    }
  } catch {
    // The content assertions below are the real check; a listing failure only
    // means the required-file check reports its own misses.
  }

  return {
    version,
    fileName: cliArtifactFileName(version),
    tarballPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: (await stat(tarballPath)).size,
    files,
  };
}

async function writeConsumerManifest(): Promise<void> {
  await copyFile(
    resolve(
      repositoryRoot,
      ".build",
      "scripts",
      "cli-consumer-driver.js",
    ),
    join(app, "driver.js"),
  );
  const driver = join(app, "driver.js");

  if (!existsSync(driver)) {
    fail(
      "the compiled consumer driver is missing; run `npm run build:scripts` first",
    );
  }

  const manifest = {
    name: "syndroo-cli-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {},
  };

  // The driver and the consumer share one module graph, so the app declares the
  // same module system the compiled driver was emitted for.
  await writeFile(
    join(app, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function checkTarballContents(): Promise<void> {
  const required = [
    "dist/bin.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/THIRD_PARTY_LICENSES.txt",
    "dist/_vendor/sdk/index.d.ts",
    "dist/_vendor/core/index.d.ts",
    "LICENSE",
    "NOTICE",
    "README.md",
    "skills/syndroo/SKILL.md",
    "package.json",
  ];

  for (const entry of required) {
    const normalized = entry === "package.json" ? "package/package.json" : entry;
    const found =
      packed.files.includes(normalized) ||
      packed.files.includes(entry) ||
      packed.files.some((file) => file.endsWith(`/${entry}`));

    if (!found) {
      fail(`tarball is missing ${entry}`);
    }
  }

  checks["tarball-contents"] = `${packed.files.length} files`;
}

async function installTarball(environment: NodeJS.ProcessEnv): Promise<void> {
  const installed = await runCommand(
    npmBinary(),
    [
      "install",
      packed.tarballPath,
      "--no-save",
      "--no-package-lock",
      "--install-links=false",
    ],
    { cwd: app, env: environment },
  );

  if (installed.code !== 0) {
    fail(
      `npm install of the tarball failed (exit ${installed.code}): ${installed.stderr.trim().slice(0, 800)}`,
    );
  } else {
    checks["install"] = "installed from the local tarball with a blank HOME";
  }
}

async function checkInstalledTree(): Promise<void> {
  const manifestPath = join(app, "node_modules", "@syndroo", "cli", "package.json");

  if (!existsSync(manifestPath)) {
    fail(`the tarball did not install ${CLI_PACKAGE_NAME}`);
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version?: unknown;
    dependencies?: Record<string, string>;
  };

  if (manifest.version !== version) {
    fail(
      `installed manifest version is ${JSON.stringify(manifest.version)}, expected ${version}`,
    );
  }

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@syndroo/") || range.startsWith("workspace:")) {
      fail(`published dependencies still reference ${name}@${range}`);
    }
  }

  // The runtime dependency list is the whole self-containment claim.
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();

  checks["runtime-dependencies"] =
    runtimeDependencies.length === 0 ? "none" : runtimeDependencies.join(", ");

  for (const name of ["@syndroo/bluesky", "@syndroo/core", "@syndroo/sdk", "@syndroo/threads"]) {
    if (existsSync(join(app, "node_modules", ...name.split("/")))) {
      fail(`${name} was installed alongside the self-contained CLI`);
    }
  }
}

async function checkCommand(environment: NodeJS.ProcessEnv): Promise<void> {
  const bin = join(app, "node_modules", "@syndroo", "cli", "dist", "bin.js");

  if (!existsSync(bin)) {
    fail("the installed package has no dist/bin.js");
    return;
  }

  if (((await stat(bin)).mode & 0o111) === 0) {
    fail("dist/bin.js is not executable in the installed package");
  }

  const firstLine = (await readFile(bin, "utf8")).split("\n")[0];

  if (firstLine !== "#!/usr/bin/env node") {
    fail(`dist/bin.js does not start with the node shebang: ${firstLine}`);
  }

  const help = await runNode(bin, ["help"], environment);

  if (help.code !== 0) {
    fail(`syndroo help exited ${help.code}: ${help.stderr.trim().slice(0, 300)}`);
  } else {
    for (const command of ["init", "providers list", "publish", "retry", "receipts", "state"]) {
      if (!help.stdout.includes(command)) {
        fail(`syndroo help does not list ${command}`);
      }
    }
  }

  const reported = await runNode(bin, ["version"], environment);

  if (reported.code !== 0 || !reported.stdout.includes(version)) {
    fail(
      `syndroo version reported ${JSON.stringify(reported.stdout.trim())}, expected ${version}`,
    );
  }

  const skill = await runNode(bin, ["skill", "path", "--json"], environment);

  try {
    const payload = JSON.parse(skill.stdout) as { path?: unknown; exists?: unknown };

    if (payload.exists !== true || typeof payload.path !== "string") {
      fail(`syndroo skill path reported ${JSON.stringify(payload)}`);
    } else if (!existsSync(payload.path)) {
      fail(`syndroo skill path pointed at a missing directory: ${payload.path}`);
    } else {
      checks["skill-path"] = "bundled Skill directory resolves inside the install";
    }
  } catch {
    fail(`syndroo skill path did not print JSON: ${skill.stdout.slice(0, 200)}`);
  }
}

async function checkLibraryImport(environment: NodeJS.ProcessEnv): Promise<void> {
  const probe = await runCommand(
    process.execPath,
    [
      "-e",
      [
        "const m = await import('@syndroo/cli');",
        "for (const name of ['run','parseArgs','cliVersion','EXIT_CODE','Reporter']) {",
        "  if (m[name] === undefined) throw new Error(name + ' is not exported');",
        "}",
        "console.log(JSON.stringify({ version: m.cliVersion() }));",
      ].join(" "),
    ],
    { cwd: app, env: environment },
  );

  if (probe.code !== 0) {
    fail(`library import failed: ${probe.stderr.trim().slice(0, 400)}`);
  } else {
    checks["library-import"] = "legacy public exports resolve from the bundle";
  }
}

async function checkDeclarations(environment: NodeJS.ProcessEnv): Promise<void> {
  const consumerSource = [
    'import { run, parseArgs, cliVersion, CliError, EXIT_CODE, Reporter } from "@syndroo/cli";',
    'import type { ParsedCommand, CommandResult, FrozenPost, DocumentIssue, CliIo } from "@syndroo/cli";',
    "",
    "export const exit: number = EXIT_CODE.SUCCESS;",
    "export const parsed: (argv: readonly string[]) => ParsedCommand = parseArgs;",
    "export const invoke: typeof run = run;",
    "export const version: () => string = cliVersion;",
    "export const error: typeof CliError = CliError;",
    "export const reporter: typeof Reporter = Reporter;",
    "export type Aliases = [ParsedCommand, CommandResult, FrozenPost, DocumentIssue, CliIo];",
    "",
  ].join("\n");

  await writeFile(
    join(app, "consumer.ts"),
    consumerSource,
    "utf8",
  );
  await writeFile(
    join(app, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // `@types/node` is a declared dependency of the package (the public
  // declarations reference `node:stream` and the `NodeJS` namespace), so a
  // consumer that does not silence library checking has to pull it in
  // explicitly. That is the documented, publicly resolvable path.
  await writeFile(
    join(app, "package.types.json"),
    `${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { types: ["node"] } }, null, 2)}\n`,
    "utf8",
  );

  const tsc = resolve(
    repositoryRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  // Run the compiler under the same Node binary as the gate, so a runtime leg
  // really is that runtime rather than whichever `node` the shebang found.
  const tscEntry = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  const compiler = existsSync(tscEntry) ? process.execPath : tsc;
  const compilerArguments = existsSync(tscEntry)
    ? [tscEntry, "--project", join(app, "package.types.json")]
    : ["--project", join(app, "package.types.json")];
  const checked = await runCommand(compiler, compilerArguments, {
    cwd: app,
    env: environment,
  });

  if (checked.code !== 0) {
    fail(
      `declarations do not type-check with skipLibCheck false:\n${`${checked.stdout}${checked.stderr}`.trim().slice(0, 1200)}`,
    );
  } else {
    checks["declarations"] = "independent consumer type-check passed with skipLibCheck false";
  }
}

async function checkLocalWorkflow(environment: NodeJS.ProcessEnv): Promise<void> {
  const driver = join(app, "driver.js");

  if (!existsSync(driver)) {
    fail("the consumer driver was not staged");
    return;
  }

  const executed = await runCommand(process.execPath, [driver], {
    cwd: app,
    env: { ...environment, SYNDROO_DRIVER_CHILD: "1" },
  });
  let payload: { readonly ok?: unknown; readonly failures?: readonly unknown[] } = {};

  try {
    payload = JSON.parse(executed.stdout) as typeof payload;
  } catch {
    fail(`the driver printed no JSON result: ${executed.stdout.slice(0, 300)}`);
  }

  if (executed.code !== 0 || payload.ok !== true) {
    const detail = Array.isArray(payload.failures) ? payload.failures.join("; ") : executed.stderr.trim();

    fail(`the packaged local workflow failed: ${detail.slice(0, 900)}`);
  } else {
    checks["local-workflow"] =
      "init, providers, doctor, malformed rejection, preview, execute, replay, receipts, secret absence";
  }
}

function runNode(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return runCommand(process.execPath, [script, ...args], {
    cwd: app,
    env: environment,
  });
}
