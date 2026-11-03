#!/usr/bin/env node
/**
 * Exercise the packed CLI and Worker outside the source checkout.
 *
 * The product artifacts are packed with lifecycle scripts disabled, then a
 * disposable HTTP registry serves only those two scoped packages. npm still
 * resolves public dependencies normally, so generated projects keep their
 * production version pins instead of receiving file: substitutions.
 *
 * No Cloudflare, GitHub or Threads endpoint is contacted. The final Wrangler
 * invocation is a local deploy dry run against the installed Worker artifact.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ROOT } from "./lib/v1-stages.ts";

const CLI_NAME = "@syndroo/cli";
const WORKER_NAME = "@syndroo/cloudflare";
const REGISTRY_REQUEST_LIMIT = 500;
const REGISTRY_LIFETIME_MS = 15 * 60_000;
const MAX_REGISTRY_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

type PackedArtifact = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly file: string;
  readonly manifest: Record<string, unknown>;
  readonly files: readonly string[];
  readonly bytes: Buffer;
  readonly shasum: string;
  readonly integrity: string;
};

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const USAGE = `Usage: node scripts/server-cli-artifact-smoke.ts [--keep]

Packs the already-built @syndroo/cli and @syndroo/cloudflare artifacts,
installs them through a bounded loopback registry in a disposable directory,
runs server init/doctor, imports the Worker, and performs a Wrangler dry run.
No package is published and no remote service is mutated.

Build first:
  npm run build --workspace @syndroo/cli
  npm run build --workspace @syndroo/cloudflare

--keep leaves the disposable directory and loopback registry files for review.
`;

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        fail(new Error(`${command} exceeded the bounded output limit`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => fail(new Error(`${command} could not start`)));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const timeout = setTimeout(
      () => fail(new Error(`${command} timed out`)),
      options.timeoutMs ?? 300_000,
    );
  });
}

async function checkedCommand(
  command: string,
  args: readonly string[],
  options: Parameters<typeof runCommand>[2],
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.exitCode}: ${detail.slice(0, 2_000)}`,
    );
  }
  return result;
}

function packageDirectory(name: string): string {
  if (name === CLI_NAME) return path.join(ROOT, "packages", "cli");
  if (name === WORKER_NAME) return path.join(ROOT, "packages", "cloudflare");
  throw new Error(`unsupported artifact ${name}`);
}

async function packArtifact(
  name: string,
  destination: string,
  environment: NodeJS.ProcessEnv,
): Promise<PackedArtifact> {
  const directory = packageDirectory(name);
  for (const required of [
    name === CLI_NAME ? "dist/bin.js" : "dist/worker.js",
    "dist/bundle.json",
  ]) {
    await readFile(path.join(directory, required));
  }
  const rawManifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(typeof rawManifest["version"], "string");
  const version = rawManifest["version"] as string;

  const packed = await checkedCommand(
    npmCommand(),
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--workspace",
      name,
      "--pack-destination",
      destination,
    ],
    { cwd: ROOT, env: environment, timeoutMs: 120_000 },
  );
  const output = JSON.parse(packed.stdout) as Array<{
    filename?: unknown;
    shasum?: unknown;
    integrity?: unknown;
    files?: Array<{ path?: unknown }>;
  }>;
  assert.ok(Array.isArray(output) && output.length === 1);
  const record = output[0];
  assert.ok(record !== undefined && typeof record.filename === "string");
  assert.equal(typeof record.shasum, "string");
  assert.equal(typeof record.integrity, "string");
  const files = (record.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
  const filename = record.filename as string;
  const file = path.join(destination, filename);
  const bytes = await readFile(file);
  assert.ok(bytes.length > 0 && bytes.length <= MAX_REGISTRY_FILE_BYTES);

  return {
    name,
    version,
    filename,
    file,
    manifest: rawManifest,
    files,
    bytes,
    shasum: record.shasum as string,
    integrity: record.integrity as string,
  };
}

function assertPackedContents(artifacts: readonly PackedArtifact[]): string {
  const cli = artifacts.find((artifact) => artifact.name === CLI_NAME);
  const worker = artifacts.find((artifact) => artifact.name === WORKER_NAME);
  assert.ok(cli !== undefined && worker !== undefined);
  assert.equal(cli.version, worker.version);

  for (const required of [
    "package.json",
    "dist/bin.js",
    "dist/index.js",
    "dist/THIRD_PARTY_LICENSES.txt",
    "README.md",
    "skills/syndroo/SKILL.md",
    "skills/syndroo/references/server.md",
  ]) {
    assert.ok(cli.files.includes(required), `CLI tarball missing ${required}`);
  }
  for (const required of [
    "package.json",
    "dist/worker.js",
    "dist/THIRD_PARTY_LICENSES.txt",
  ]) {
    assert.ok(worker.files.includes(required), `Worker tarball missing ${required}`);
  }
  return cli.version;
}

type LoopbackRegistry = {
  readonly origin: string;
  close(): Promise<void>;
};

async function startRegistry(
  artifacts: readonly PackedArtifact[],
): Promise<LoopbackRegistry> {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  const byTarball = new Map(artifacts.map((artifact) => [artifact.filename, artifact]));
  let requests = 0;
  let origin = "";
  const server = createServer((request, response) => {
    requests += 1;
    if (requests > REGISTRY_REQUEST_LIMIT || request.method !== "GET") {
      response.writeHead(requests > REGISTRY_REQUEST_LIMIT ? 429 : 405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", origin).pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const name = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    const artifact = byName.get(name);
    if (artifact !== undefined) {
      const metadata = {
        ...artifact.manifest,
        dist: {
          tarball: `${origin}/tarballs/${artifact.filename}`,
          shasum: artifact.shasum,
          integrity: artifact.integrity,
        },
      };
      const body = Buffer.from(JSON.stringify({
        name: artifact.name,
        "dist-tags": { latest: artifact.version },
        versions: { [artifact.version]: metadata },
      }));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    const tarballName = pathname.startsWith("/tarballs/")
      ? pathname.slice("/tarballs/".length)
      : "";
    const tarball = byTarball.get(tarballName);
    if (tarball !== undefined) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(tarball.bytes.length),
        "cache-control": "no-store",
      });
      response.end(tarball.bytes);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("loopback registry has no address"));
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  const lifetime = setTimeout(() => server.close(), REGISTRY_LIFETIME_MS);
  return {
    origin,
    async close(): Promise<void> {
      clearTimeout(lifetime);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function assertNoSourceDependency(
  projectDirectory: string,
  version: string,
): Promise<void> {
  const project = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(project.dependencies?.[CLI_NAME], version);
  assert.equal(project.dependencies?.[WORKER_NAME], version);
  assert.equal(project.devDependencies?.["wrangler"], "4.132.0");

  const lockText = await readFile(path.join(projectDirectory, "package-lock.json"), "utf8");
  assert.doesNotMatch(lockText, /(?:file:|link:|\.\.\/|\.\/packages\/)/u);
  assert.doesNotMatch(lockText, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  const lock = JSON.parse(lockText) as {
    packages?: Record<string, { version?: string; resolved?: string }>;
  };
  for (const name of [CLI_NAME, WORKER_NAME]) {
    const installed = lock.packages?.[`node_modules/${name}`];
    assert.equal(installed?.version, version);
    assert.match(installed?.resolved ?? "", /^http:\/\/127\.0\.0\.1:\d+\/tarballs\//u);
  }
}

async function assertGeneratedFiles(projectDirectory: string): Promise<void> {
  const required = [
    ".gitignore",
    "package.json",
    "package-lock.json",
    "syndroo.config.jsonc",
    "wrangler.jsonc",
    "posts/hello.json",
  ];
  for (const relative of required) {
    const bytes = await readFile(path.join(projectDirectory, relative));
    assert.ok(bytes.length > 0, `${relative} is empty`);
  }
  const ignored = await readFile(path.join(projectDirectory, ".gitignore"), "utf8");
  for (const entry of [
    "node_modules/",
    ".syndroo/",
    "wrangler.effective.jsonc",
    ".env",
  ]) {
    assert.ok(ignored.split(/\r?\n/u).includes(entry), `.gitignore missing ${entry}`);
  }
  const config = await readFile(path.join(projectDirectory, "syndroo.config.jsonc"), "utf8");
  assert.doesNotMatch(config, /API_BEARER|SECRET_KEY|RUNTIME_KEY|account[_-]?id/iu);
  const wrangler = await readFile(path.join(projectDirectory, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /@syndroo\/cloudflare\/dist\/worker\.js/u);
  assert.match(wrangler, /global_fetch_strictly_public/u);
}

async function importInstalledArtifacts(
  projectDirectory: string,
  environment: NodeJS.ProcessEnv,
  version: string,
): Promise<void> {
  const probe = [
    `const cli = await import("@syndroo/cli");`,
    `if (typeof cli.run !== "function" || typeof cli.cliVersion !== "function") throw new Error("CLI exports unavailable");`,
    `const runtime = await import("@syndroo/cli/runtime");`,
    `if (typeof runtime.createLocalRuntime !== "function") throw new Error("CLI runtime exports unavailable");`,
    `const worker = await import("@syndroo/cloudflare");`,
    `if (typeof worker.default?.fetch !== "function") throw new Error("Worker fetch export unavailable");`,
    `process.stdout.write(cli.cliVersion());`,
  ].join("\n");
  const result = await checkedCommand(
    process.execPath,
    ["--input-type=module", "-e", probe],
    { cwd: projectDirectory, env: environment, timeoutMs: 30_000 },
  );
  assert.equal(result.stdout.trim(), version);
}

async function listFiles(
  directory: string,
  skippedDirectories: ReadonlySet<string>,
): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      output.push(...await listFiles(full, skippedDirectories));
    }
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

async function assertPackedCliWorkflowCommand(artifact: PackedArtifact): Promise<void> {
  const text = await readFile(path.join(packageDirectory(artifact.name), "dist", "bin.js"), "utf8");
  assert.match(text, /npx --no-install syndroo server publish threads/u);
  assert.match(text, /--request-id "\$REQUEST_ID"/u);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = args.filter((argument) => argument !== "--keep");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument ${JSON.stringify(unknown[0])}.\n${USAGE}`);
    return 1;
  }
  const keep = args.includes("--keep");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "syndroo-server-artifact-"));
  let registry: LoopbackRegistry | undefined;

  try {
    const packDirectory = path.join(temporaryRoot, "packs");
    const home = path.join(temporaryRoot, "home");
    const toolDirectory = path.join(temporaryRoot, "tool");
    const projectParent = path.join(temporaryRoot, "external");
    const projectDirectory = path.join(projectParent, "syndroo-site");
    const packCache = path.join(temporaryRoot, "pack-cache");
    const packLogs = path.join(temporaryRoot, "pack-logs");
    await Promise.all([
      mkdir(packDirectory),
      mkdir(home),
      mkdir(toolDirectory),
      mkdir(projectParent),
      mkdir(packCache),
      mkdir(packLogs),
    ]);
    await writeFile(
      path.join(home, ".gitconfig"),
      `[user]\n  name = Syndroo Artifact Smoke\n  email = artifact-smoke@example.invalid\n[commit]\n  gpgsign = false\n`,
      { mode: 0o600 },
    );

    process.stdout.write("Pack built artifacts\n");
    const packEnvironment = {
      ...process.env,
      NPM_CONFIG_CACHE: packCache,
      NPM_CONFIG_LOGS_DIR: packLogs,
    };
    const artifacts = [
      await packArtifact(CLI_NAME, packDirectory, packEnvironment),
      await packArtifact(WORKER_NAME, packDirectory, packEnvironment),
    ];
    const version = assertPackedContents(artifacts);
    await assertPackedCliWorkflowCommand(artifacts[0] as PackedArtifact);

    registry = await startRegistry(artifacts);
    const npmrc = path.join(home, ".npmrc");
    const npmCache = (await checkedCommand(
      npmCommand(),
      ["config", "get", "cache"],
      { cwd: ROOT, timeoutMs: 30_000 },
    )).stdout.trim();
    await writeFile(
      npmrc,
      [
        "registry=https://registry.npmjs.org/",
        `@syndroo:registry=${registry.origin}/`,
        `cache=${npmCache}`,
        "prefer-offline=true",
        "fetch-retries=2",
        "strict-ssl=true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: path.join(temporaryRoot, "tmp"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_STATE_HOME: path.join(home, ".state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      NPM_CONFIG_USERCONFIG: npmrc,
      NO_COLOR: "1",
    };
    await mkdir(environment.TMPDIR as string);

    process.stdout.write("Install packed CLI through loopback registry\n");
    await checkedCommand(
      npmCommand(),
      [
        "install",
        "--prefix",
        toolDirectory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `${CLI_NAME}@${version}`,
      ],
      { cwd: temporaryRoot, env: environment, timeoutMs: 300_000 },
    );
    const installedCli = JSON.parse(
      await readFile(
        path.join(toolDirectory, "node_modules", CLI_NAME, "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    assert.equal(installedCli.version, version);
    const syndroo = path.join(toolDirectory, "node_modules", ".bin", "syndroo");

    process.stdout.write("Initialize generated project outside source tree\n");
    await checkedCommand(
      syndroo,
      ["server", "init", projectDirectory],
      { cwd: projectParent, env: environment, timeoutMs: 600_000 },
    );
    const resolvedRoot = await realpath(ROOT);
    const resolvedProject = await realpath(projectDirectory);
    assert.equal(resolvedProject.startsWith(`${resolvedRoot}${path.sep}`), false);
    await assertGeneratedFiles(projectDirectory);
    await assertNoSourceDependency(projectDirectory, version);

    process.stdout.write("Run installed help and read-only doctor\n");
    const help = await checkedCommand(syndroo, ["server", "--help"], {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: 30_000,
    });
    for (const command of ["init", "doctor", "deploy", "connect", "publish", "ci"]) {
      assert.match(help.stdout, new RegExp(`\\b${command}\\b`, "u"));
    }
    const deployHelp = await checkedCommand(syndroo, ["server", "deploy", "--help"], {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: 30_000,
    });
    assert.match(deployHelp.stdout, /--recover <path>/u);
    assert.match(deployHelp.stdout, /--credentials-stdin/u);
    const workflowHelp = await checkedCommand(
      npxCommand(),
      ["--no-install", "syndroo", "server", "publish", "threads", "--help"],
      { cwd: projectDirectory, env: environment, timeoutMs: 30_000 },
    );
    assert.match(workflowHelp.stdout, /Usage: syndroo server publish threads/u);
    const doctor = await checkedCommand(
      syndroo,
      ["server", "doctor", "--json"],
      { cwd: projectDirectory, env: environment, timeoutMs: 60_000 },
    );
    const envelope = JSON.parse(doctor.stdout) as {
      ok?: unknown;
      result?: { subcommand?: unknown };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result?.subcommand, "doctor");

    process.stdout.write("Import installed CLI and Worker modules\n");
    await importInstalledArtifacts(projectDirectory, environment, version);
    const installedProjectFiles = await listFiles(
      projectDirectory,
      new Set(["node_modules", ".git"]),
    );
    for (const file of installedProjectFiles) {
      const text = await readFile(file, "utf8").catch(() => "");
      assert.equal(text.includes(resolvedRoot), false, `${file} contains source path`);
    }

    process.stdout.write("Run isolated Wrangler deploy dry run\n");
    const dryRunDirectory = path.join(temporaryRoot, "dry-run");
    const wrangler = path.join(projectDirectory, "node_modules", ".bin", "wrangler");
    await checkedCommand(
      wrangler,
      ["deploy", "--dry-run", "--config", "wrangler.jsonc", "--outdir", dryRunDirectory],
      {
        cwd: projectDirectory,
        env: { ...environment, WRANGLER_SEND_METRICS: "false", CI: "true" },
        timeoutMs: 120_000,
      },
    );
    const workerBundle = await readFile(path.join(dryRunDirectory, "worker.js"));
    assert.ok(workerBundle.length > 0);

    process.stdout.write(
      `Artifact smoke passed: ${CLI_NAME}@${version}, ${WORKER_NAME}@${version}, external=${resolvedProject}\n`,
    );
    return 0;
  } finally {
    await registry?.close().catch(() => undefined);
    if (keep) {
      process.stderr.write(`Artifact smoke files retained at ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `Artifact smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
