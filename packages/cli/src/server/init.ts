import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE, type ExitCode } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import {
  SERVER_CONFIG_FILE,
  DEFAULT_SERVER_SCOPE,
  loadServerConfig,
  resolveServerProject,
  type ServerConfig,
} from "./config.js";
import {
  GENERATED_FILES,
  GENERATED_MARKER,
  SERVER_DEPENDENCY_VERSIONS,
  ensureProjectDirectory,
  readProjectFile,
  readProjectText,
  writeNewProjectFile,
} from "./foundation.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process.js";
import {
  readPrivateStateFile,
  writePrivateStateFile,
} from "./state.js";

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const RECOVERY_FILE = "recovery.json";
const RECOVERY_DIRECTORY = ".syndroo";
const INIT_RECORD_FILE = "init.json";
const TEMPLATE_FILES = [
  ".gitignore",
  "package.json",
  SERVER_CONFIG_FILE,
  "wrangler.jsonc",
  "posts/hello.json",
] as const;
const INITIAL_COMMIT_MESSAGE = "chore: initialize Syndroo deployment";
const SIGNED_OFF_BY = /^Signed-off-by: .+ <[^<>\r\n]+>$/m;

export type GithubVisibility = "private" | "public";

export type GithubTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly visibility: GithubVisibility;
};

export type ServerInitOptions = {
  readonly projectDirectory?: string;
  readonly directory?: string;
  readonly github?: string;
  readonly visibility?: GithubVisibility;
};

export type ServerInitResult = {
  readonly subcommand: "init";
  readonly status: "initialized" | "unchanged";
  readonly projectDirectory: string;
  readonly projectId: string;
  readonly github: {
    readonly owner: string;
    readonly repo: string;
    readonly visibility: GithubVisibility;
    readonly pushed: boolean;
  } | null;
};

export type InitDependencies = {
  readonly io: CliIo;
  readonly runner: ProcessRunner;
  readonly randomUUID?: () => string;
};

type Destination =
  | { readonly kind: "missing" | "empty" }
  | {
      readonly kind: "partial";
      readonly record: InitRecord;
    }
  | {
      readonly kind: "recognized";
      readonly config: ServerConfig;
    }
  | { readonly kind: "conflict" };

type RecoveryRecord = {
  readonly version: 1;
  readonly step: "remote-created" | "complete";
  readonly github: GithubTarget;
  readonly remoteId: string;
  readonly head: string;
};

type InitPhase =
  | "prepared"
  | "generated"
  | "installing"
  | "installed"
  | "committing"
  | "complete";

type InitRecord = {
  readonly version: 1;
  readonly projectId: string;
  readonly phase: InitPhase;
  readonly files: Readonly<Record<string, string>>;
};

type GithubView = {
  readonly id: string;
  readonly nameWithOwner: string;
  readonly isPrivate: boolean;
  readonly url: string;
};

function serverError(
  code: string,
  nextAction: string,
  exitCode: ExitCode = EXIT_CODE.USAGE,
): CliError {
  return new CliError(code, {
    code,
    exitCode,
    details: { nextAction },
  });
}

function commandSucceeded(result: ProcessResult): boolean {
  return result.status === "exited" && result.exitCode === 0;
}

function processFailure(
  result: ProcessResult,
  fallbackCode: string,
  nextAction: string,
): CliError {
  if (result.status === "timed_out") {
    return serverError("SERVER_PROCESS_TIMEOUT", "RETRY_INIT", EXIT_CODE.FAILURE);
  }
  if (result.status === "output_limit") {
    return serverError(
      "SERVER_PROCESS_OUTPUT_LIMIT",
      "CHECK_TOOL_CONFIGURATION",
      EXIT_CODE.FAILURE,
    );
  }
  if (result.status === "spawn_error") {
    return serverError(fallbackCode, nextAction, EXIT_CODE.USAGE);
  }
  return serverError(fallbackCode, nextAction, EXIT_CODE.FAILURE);
}

function projectSlug(projectDirectory: string): string {
  const candidate = path
    .basename(projectDirectory)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
  return candidate.length === 0 ? "syndroo-deployment" : candidate;
}

export function parseGithubTarget(
  raw: string,
  visibility: GithubVisibility,
): GithubTarget {
  if (raw.length > 201 || (raw.match(/\//g) ?? []).length !== 1) {
    throw serverError("SERVER_GITHUB_TARGET_INVALID", "CHOOSE_OWNER_REPOSITORY");
  }
  const [owner, repo] = raw.split("/");
  if (
    owner === undefined ||
    repo === undefined ||
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_NAME.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw serverError("SERVER_GITHUB_TARGET_INVALID", "CHOOSE_OWNER_REPOSITORY");
  }
  return { owner, repo, visibility };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readInitRecord(projectDirectory: string): Promise<InitRecord | null> {
  const stateDirectory = path.join(projectDirectory, RECOVERY_DIRECTORY);
  try {
    const stat = await fs.lstat(stateDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw serverError("SERVER_PROJECT_CONFLICT", "INSPECT_PROJECT_FILES");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw serverError("SERVER_PROJECT_CONFLICT", "INSPECT_PROJECT_FILES");
  }

  const bytes = await readPrivateStateFile(stateDirectory, INIT_RECORD_FILE);
  if (bytes === null) {
    return null;
  }

  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { version?: unknown }).version !== 1 ||
      typeof (value as { projectId?: unknown }).projectId !== "string" ||
      ![
        "prepared",
        "generated",
        "installing",
        "installed",
        "committing",
        "complete",
      ].includes((value as { phase?: string }).phase ?? "") ||
      typeof (value as { files?: unknown }).files !== "object" ||
      (value as { files?: unknown }).files === null
    ) {
      throw new Error("invalid init record");
    }
    const files = (value as { files: Record<string, unknown> }).files;
    if (
      JSON.stringify(Object.keys(files).sort()) !==
        JSON.stringify([...TEMPLATE_FILES].sort()) ||
      Object.values(files).some(
        (value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value),
      )
    ) {
      throw new Error("invalid init record files");
    }
    return value as InitRecord;
  } catch {
    throw serverError("SERVER_PROJECT_CONFLICT", "INSPECT_PROJECT_FILES");
  }
}

function hasExpectedPackageStructure(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  try {
    const value = JSON.parse(text) as {
      private?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      syndroo?: unknown;
    };
    return (
      value.private === true &&
      JSON.stringify(value.syndroo) === JSON.stringify(GENERATED_MARKER) &&
      value.dependencies?.["@syndroo/cli"] === SERVER_DEPENDENCY_VERSIONS.cli &&
      value.dependencies?.["@syndroo/cloudflare"] ===
        SERVER_DEPENDENCY_VERSIONS.cloudflare &&
      value.devDependencies?.["wrangler"] === SERVER_DEPENDENCY_VERSIONS.wrangler
    );
  } catch {
    return false;
  }
}

async function inspectCompletedProject(
  projectDirectory: string,
  record: InitRecord,
): Promise<ServerConfig | null> {
  try {
    const loaded = await loadServerConfig(projectDirectory);
    if (loaded.config.projectId !== record.projectId) {
      return null;
    }
    if (
      !hasExpectedPackageStructure(
        await readProjectText(path.join(projectDirectory, "package.json")),
      )
    ) {
      return null;
    }
    for (const relative of TEMPLATE_FILES) {
      if (
        (await readProjectFile(path.join(projectDirectory, relative))) === null
      ) {
        return null;
      }
    }

    const lock = await fs.lstat(
      path.join(projectDirectory, "package-lock.json"),
    );
    const git = await fs.lstat(path.join(projectDirectory, ".git"));
    if (
      lock.isSymbolicLink() ||
      !lock.isFile() ||
      git.isSymbolicLink() ||
      !git.isDirectory()
    ) {
      return null;
    }
    return loaded.config;
  } catch {
    return null;
  }
}

async function inspectDestination(projectDirectory: string): Promise<Destination> {
  let stat;
  try {
    stat = await fs.lstat(projectDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw serverError("SERVER_PROJECT_UNREADABLE", "INSPECT_PROJECT_FILES");
  }

  if (stat.isSymbolicLink()) {
    throw serverError("SERVER_PROJECT_CONFLICT", "CHOOSE_EMPTY_DIRECTORY");
  }
  if (!stat.isDirectory()) {
    throw serverError("SERVER_PROJECT_CONFLICT", "CHOOSE_EMPTY_DIRECTORY");
  }

  const entries = await fs.readdir(projectDirectory);
  if (entries.length === 0) {
    return { kind: "empty" };
  }

  try {
    const record = await readInitRecord(projectDirectory);
    if (record === null) {
      return { kind: "conflict" };
    }
    const expected = generatedTemplateDigests(projectDirectory, record.projectId);
    if (TEMPLATE_FILES.some((relative) => record.files[relative] !== expected[relative])) {
      return { kind: "conflict" };
    }

    if (record.phase === "complete") {
      const config = await inspectCompletedProject(projectDirectory, record);
      return config === null
        ? { kind: "conflict" }
        : { kind: "recognized", config };
    }

    for (const relative of TEMPLATE_FILES) {
      const bytes = await readProjectFile(path.join(projectDirectory, relative));
      if (bytes === null) {
        if (record.phase !== "prepared") {
          return { kind: "conflict" };
        }
        continue;
      }
      if (digest(bytes) !== expected[relative]) {
        return { kind: "conflict" };
      }
    }

    return { kind: "partial", record };
  } catch {
    return { kind: "conflict" };
  }
}

async function run(
  runner: ProcessRunner,
  request: ProcessRequest,
): Promise<ProcessResult> {
  return await runner.run(request);
}

async function preflightGit(
  runner: ProcessRunner,
  cwd: string,
): Promise<void> {
  const version = await run(runner, { tool: "git", args: ["--version"], cwd });
  if (!commandSucceeded(version)) {
    throw processFailure(version, "SERVER_GIT_UNAVAILABLE", "INSTALL_GIT");
  }

  for (const key of ["user.name", "user.email"]) {
    const configured = await run(runner, {
      tool: "git",
      args: ["config", "--get", key],
      cwd,
    });
    if (!commandSucceeded(configured) || configured.stdout.trim().length === 0) {
      throw serverError("SERVER_GIT_IDENTITY_REQUIRED", "CONFIGURE_GIT_IDENTITY");
    }
  }
}

async function preflightGithub(
  runner: ProcessRunner,
  cwd: string,
  target: GithubTarget,
  allowExisting: boolean,
): Promise<GithubView | null> {
  const auth = await run(runner, { tool: "gh", args: ["auth", "status"], cwd });
  if (!commandSucceeded(auth)) {
    throw processFailure(auth, "SERVER_GITHUB_AUTH_REQUIRED", "AUTHENTICATE_GITHUB");
  }

  const viewed = await run(runner, {
    tool: "gh",
    args: [
      "repo",
      "view",
      `${target.owner}/${target.repo}`,
      "--json",
      "id,nameWithOwner,isPrivate,url",
    ],
    cwd,
  });
  const view = githubView(viewed);
  if (!allowExisting && view !== null) {
    throw serverError("SERVER_GITHUB_COLLISION", "CHOOSE_NEW_REPOSITORY");
  }
  if (viewed.status !== "exited" || (viewed.exitCode !== 0 && viewed.exitCode !== 1)) {
    throw processFailure(viewed, "SERVER_GITHUB_UNAVAILABLE", "CHECK_GITHUB_ACCESS");
  }
  if (allowExisting && view === null) {
    throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
  }
  if (view !== null) {
    verifyGithubView(target, view);
  }
  return view;
}

function githubView(result: ProcessResult): GithubView | null {
  if (!commandSucceeded(result)) {
    return null;
  }
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as GithubView).id !== "string" ||
      (value as GithubView).id.length === 0 ||
      typeof (value as GithubView).nameWithOwner !== "string" ||
      typeof (value as GithubView).isPrivate !== "boolean" ||
      typeof (value as GithubView).url !== "string"
    ) {
      throw new Error("invalid GitHub response");
    }
    return value as GithubView;
  } catch {
    throw serverError("SERVER_GITHUB_UNAVAILABLE", "CHECK_GITHUB_ACCESS");
  }
}

function verifyGithubView(target: GithubTarget, view: GithubView): void {
  if (
    view.nameWithOwner.toLowerCase() !==
      `${target.owner}/${target.repo}`.toLowerCase() ||
    view.isPrivate !== (target.visibility === "private") ||
    view.url.replace(/\/$/, "").toLowerCase() !==
      `https://github.com/${target.owner}/${target.repo}`.toLowerCase()
  ) {
    throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
  }
}

function packageManifest(projectDirectory: string): string {
  return `${JSON.stringify(
    {
      name: "syndroo-deployment",
      version: "1.0.0",
      private: true,
      type: "module",
      engines: { node: ">=24.19.0" },
      scripts: {
        doctor: "syndroo server doctor",
      },
      dependencies: {
        "@syndroo/cli": SERVER_DEPENDENCY_VERSIONS.cli,
        "@syndroo/cloudflare": SERVER_DEPENDENCY_VERSIONS.cloudflare,
      },
      devDependencies: {
        wrangler: SERVER_DEPENDENCY_VERSIONS.wrangler,
      },
      syndroo: GENERATED_MARKER,
    },
    null,
    2,
  )}\n`;
}

function wranglerConfig(projectDirectory: string): string {
  const name = projectSlug(projectDirectory);
  const workQueue = `${name}-work`;
  const deadQueue = `${name}-dead`;
  return `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(name)},
  "main": "./node_modules/@syndroo/cloudflare/dist/worker.js",
  "compatibility_date": "2026-09-02",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "vars": {
    "QUEUE_NAME": ${JSON.stringify(workQueue)},
    "DLQ_NAME": ${JSON.stringify(deadQueue)},
    "PUBLIC_FETCH_STRICT": "enabled"
  },
  "secrets": {
    "required": ["API_BEARER", "SECRET_KEY", "RUNTIME_KEY"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": ${JSON.stringify(name)}
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "WORK_QUEUE",
        "queue": ${JSON.stringify(workQueue)}
      }
    ],
    "consumers": [
      {
        "queue": ${JSON.stringify(workQueue)},
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "retry_delay": 60
      },
      {
        "queue": ${JSON.stringify(deadQueue)},
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 0
      }
    ]
  },
  "triggers": {
    "crons": ["*/15 * * * *"]
  },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
`;
}

function applicationConfig(projectId: string): string {
  return `{
  // Application settings only. Secret values never belong in this file.
  "version": 1,
  "projectId": ${JSON.stringify(projectId)},
  "scope": ${JSON.stringify(DEFAULT_SERVER_SCOPE)}
}
`;
}

type GeneratedTemplate = {
  readonly relative: (typeof TEMPLATE_FILES)[number];
  readonly text: string;
};

function generatedTemplates(
  projectDirectory: string,
  projectId: string,
): readonly GeneratedTemplate[] {
  return [
    {
      relative: ".gitignore",
      text: `node_modules/\n.wrangler/\n.syndroo/\nwrangler.effective.jsonc\n.env\n.env.*\n!.env.example\n`,
    },
    {
      relative: "package.json",
      text: packageManifest(projectDirectory),
    },
    {
      relative: SERVER_CONFIG_FILE,
      text: applicationConfig(projectId),
    },
    {
      relative: "wrangler.jsonc",
      text: wranglerConfig(projectDirectory),
    },
    {
      relative: "posts/hello.json",
      text: '{\n  "text": "Hello from Syndroo CI"\n}\n',
    },
  ];
}

function generatedTemplateDigests(
  projectDirectory: string,
  projectId: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    generatedTemplates(projectDirectory, projectId).map((file) => [
      file.relative,
      digest(Buffer.from(file.text)),
    ]),
  );
}

async function writeInitRecord(
  projectDirectory: string,
  record: InitRecord,
): Promise<void> {
  try {
    await writePrivateStateFile(
      path.join(projectDirectory, RECOVERY_DIRECTORY),
      INIT_RECORD_FILE,
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
    );
  } catch {
    throw serverError("SERVER_PROJECT_WRITE_FAILED", "INSPECT_PROJECT_FILES");
  }
}

async function writeMissingTemplates(
  projectDirectory: string,
  record: InitRecord,
): Promise<void> {
  await ensureProjectDirectory(projectDirectory);
  const posts = path.join(projectDirectory, "posts");
  let postsStat = await fs.lstat(posts).catch(() => undefined);
  if (postsStat === undefined) {
    await fs.mkdir(posts, { mode: 0o700 });
    postsStat = await fs.lstat(posts);
  }
  if (postsStat.isSymbolicLink() || !postsStat.isDirectory()) {
    throw serverError("SERVER_PROJECT_CONFLICT", "INSPECT_PROJECT_FILES");
  }

  for (const file of generatedTemplates(projectDirectory, record.projectId)) {
    const existing = await readProjectFile(path.join(projectDirectory, file.relative));
    if (existing === null) {
      await writeNewProjectFile(projectDirectory, file.relative, file.text);
    }
  }
}

async function initializeGeneratedProject(
  projectDirectory: string,
  projectId: string,
): Promise<InitRecord> {
  await ensureProjectDirectory(projectDirectory);
  const prepared: InitRecord = {
    version: 1,
    projectId,
    phase: "prepared",
    files: generatedTemplateDigests(projectDirectory, projectId),
  };
  await writeInitRecord(projectDirectory, prepared);
  await writeMissingTemplates(projectDirectory, prepared);

  const generated: InitRecord = { ...prepared, phase: "generated" };
  await writeInitRecord(projectDirectory, generated);
  return generated;
}

async function installPinnedPackages(
  runner: ProcessRunner,
  projectDirectory: string,
  record: InitRecord,
): Promise<InitRecord> {
  const installing: InitRecord = { ...record, phase: "installing" };
  await writeInitRecord(projectDirectory, installing);
  const installed = await run(runner, {
    tool: "npm",
    args: [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    cwd: projectDirectory,
    timeoutMs: 300_000,
    maxOutputBytes: 65_536,
  });
  if (!commandSucceeded(installed)) {
    throw processFailure(
      installed,
      "SERVER_PACKAGE_UNAVAILABLE",
      "VERIFY_PINNED_PACKAGE_AVAILABILITY",
    );
  }

  const lock = await readProjectFile(path.join(projectDirectory, "package-lock.json"));
  if (lock === null) {
    throw serverError(
      "SERVER_PACKAGE_LOCK_MISSING",
      "RETRY_PACKAGE_INSTALL",
      EXIT_CODE.FAILURE,
    );
  }
  const next: InitRecord = { ...installing, phase: "installed" };
  await writeInitRecord(projectDirectory, next);
  return next;
}

async function gitDirectoryExists(projectDirectory: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(projectDirectory, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

async function readLocalHead(
  runner: ProcessRunner,
  projectDirectory: string,
): Promise<string | null> {
  const local = await run(runner, {
    tool: "git",
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: projectDirectory,
  });
  if (!commandSucceeded(local)) {
    return null;
  }
  const head = local.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(head)) {
    throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }
  return head;
}

async function verifyRecoveredInitialCommit(
  runner: ProcessRunner,
  projectDirectory: string,
  expectedHead: string,
): Promise<void> {
  const count = await run(runner, {
    tool: "git",
    args: ["rev-list", "--count", "HEAD"],
    cwd: projectDirectory,
  });
  if (!commandSucceeded(count) || count.stdout.trim() !== "1") {
    throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }

  const listed = await run(runner, {
    tool: "git",
    args: ["ls-tree", "-r", "--name-only", "HEAD"],
    cwd: projectDirectory,
  });
  const expectedFiles = [...GENERATED_FILES].sort();
  const actualFiles = listed.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .sort();
  if (
    !commandSucceeded(listed) ||
    JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)
  ) {
    throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }

  for (const relative of GENERATED_FILES) {
    const committed = await run(runner, {
      tool: "git",
      args: ["show", `HEAD:${relative}`],
      cwd: projectDirectory,
      maxOutputBytes: 1_048_576,
    });
    const working = await readProjectFile(
      path.join(projectDirectory, relative),
    );
    if (
      !commandSucceeded(committed) ||
      working === null ||
      !Buffer.from(committed.stdout).equals(working)
    ) {
      throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
    }
  }

  const message = await run(runner, {
    tool: "git",
    args: ["log", "-1", "--format=%B", "HEAD"],
    cwd: projectDirectory,
    maxOutputBytes: 65_536,
  });
  if (
    !commandSucceeded(message) ||
    message.stdout.split(/\r?\n/, 1)[0] !== INITIAL_COMMIT_MESSAGE ||
    !SIGNED_OFF_BY.test(message.stdout)
  ) {
    throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }

  if ((await readLocalHead(runner, projectDirectory)) !== expectedHead) {
    throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }
}

async function createInitialCommit(
  runner: ProcessRunner,
  projectDirectory: string,
  record: InitRecord,
): Promise<InitRecord> {
  const committing: InitRecord = { ...record, phase: "committing" };
  await writeInitRecord(projectDirectory, committing);
  if (!(await gitDirectoryExists(projectDirectory))) {
    const initialized = await run(runner, {
      tool: "git",
      args: ["init", "--initial-branch=main", "."],
      cwd: projectDirectory,
    });
    if (!commandSucceeded(initialized)) {
      throw processFailure(initialized, "SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
    }
  }

  if (record.phase === "committing") {
    const existingHead = await readLocalHead(runner, projectDirectory);
    if (existingHead !== null) {
      await verifyRecoveredInitialCommit(
        runner,
        projectDirectory,
        existingHead,
      );
      const complete: InitRecord = { ...committing, phase: "complete" };
      await writeInitRecord(projectDirectory, complete);
      return complete;
    }
  }

  const added = await run(runner, {
    tool: "git",
    args: ["add", "--", ...GENERATED_FILES],
    cwd: projectDirectory,
  });
  if (!commandSucceeded(added)) {
    throw processFailure(added, "SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }

  const staged = await run(runner, {
    tool: "git",
    args: ["diff", "--cached", "--name-only"],
    cwd: projectDirectory,
  });
  if (!commandSucceeded(staged)) {
    throw processFailure(staged, "SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }
  const expected = [...GENERATED_FILES].sort();
  const actual = staged.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw serverError("SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }

  const committed = await run(runner, {
    tool: "git",
    args: ["commit", "--signoff", "-m", INITIAL_COMMIT_MESSAGE],
    cwd: projectDirectory,
  });
  if (!commandSucceeded(committed)) {
    throw processFailure(committed, "SERVER_GIT_FAILED", "INSPECT_GIT_STATE");
  }
  const complete: InitRecord = { ...committing, phase: "complete" };
  await writeInitRecord(projectDirectory, complete);
  return complete;
}

async function loadRecovery(projectDirectory: string): Promise<RecoveryRecord | null> {
  const directory = path.join(projectDirectory, RECOVERY_DIRECTORY);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw serverError("SERVER_RECOVERY_CONFLICT", "INSPECT_PROJECT_STATE");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw serverError("SERVER_RECOVERY_CONFLICT", "INSPECT_PROJECT_STATE");
  }

  const bytes = await readPrivateStateFile(directory, RECOVERY_FILE);
  if (bytes === null) {
    return null;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { version?: unknown }).version !== 1 ||
      !["remote-created", "complete"].includes((value as { step?: string }).step ?? "") ||
      typeof (value as { remoteId?: unknown }).remoteId !== "string" ||
      (value as { remoteId: string }).remoteId.length === 0 ||
      typeof (value as { head?: unknown }).head !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test((value as { head: string }).head)
    ) {
      throw new Error("invalid recovery");
    }
    return value as RecoveryRecord;
  } catch {
    throw serverError("SERVER_RECOVERY_CONFLICT", "INSPECT_PROJECT_STATE");
  }
}

async function writeRecovery(
  projectDirectory: string,
  step: RecoveryRecord["step"],
  target: GithubTarget,
  verified: { readonly remoteId: string; readonly head: string },
): Promise<void> {
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        step,
        github: target,
        ...verified,
      },
      null,
      2,
    )}\n`,
  );
  try {
    await writePrivateStateFile(
      path.join(projectDirectory, RECOVERY_DIRECTORY),
      RECOVERY_FILE,
      bytes,
    );
  } catch {
    throw serverError("SERVER_RECOVERY_WRITE_FAILED", "INSPECT_PROJECT_STATE");
  }
}

async function localRemote(
  runner: ProcessRunner,
  projectDirectory: string,
): Promise<string | null> {
  const remote = await run(runner, {
    tool: "git",
    args: ["remote", "get-url", "origin"],
    cwd: projectDirectory,
  });
  if (!commandSucceeded(remote)) {
    return null;
  }
  return remote.stdout.trim();
}

export function matchingGithubRemote(
  remote: string | null,
  target: GithubTarget,
): boolean {
  if (remote === null) {
    return false;
  }
  const normalized = remote.toLowerCase().replace(/\.git$/, "");
  const repository = `${target.owner}/${target.repo}`.toLowerCase();
  return [
    `https://github.com/${repository}`,
    `git@github.com:${repository}`,
    `ssh://git@github.com/${repository}`,
    `ssh://git@github.com:22/${repository}`,
  ].includes(normalized);
}

async function remoteBranchHead(
  runner: ProcessRunner,
  projectDirectory: string,
): Promise<string | null> {
  const remote = await run(runner, {
    tool: "git",
    args: ["ls-remote", "origin", "refs/heads/main"],
    cwd: projectDirectory,
    timeoutMs: 60_000,
    maxOutputBytes: 8_192,
  });
  if (!commandSucceeded(remote)) {
    throw serverError(
      "SERVER_GITHUB_RECOVERY_CONFLICT",
      "INSPECT_GITHUB_REPOSITORY",
    );
  }
  const line = remote.stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.endsWith("\trefs/heads/main"));
  if (line === undefined) {
    return null;
  }
  const head = line.split(/\s+/)[0];
  if (head === undefined || !/^[0-9a-f]{40,64}$/i.test(head)) {
    throw serverError(
      "SERVER_GITHUB_RECOVERY_CONFLICT",
      "INSPECT_GITHUB_REPOSITORY",
    );
  }
  return head;
}

async function verifyPushedHead(
  runner: ProcessRunner,
  projectDirectory: string,
): Promise<string> {
  const localHead = await readLocalHead(runner, projectDirectory);
  if (localHead === null) {
    throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_PROJECT_STATE");
  }

  const remoteHead = await remoteBranchHead(runner, projectDirectory);
  if (
    remoteHead === null ||
    remoteHead.toLowerCase() !== localHead.toLowerCase()
  ) {
    throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
  }

  return localHead;
}

async function createAndPushRemote(
  runner: ProcessRunner,
  projectDirectory: string,
  target: GithubTarget,
  remoteAlreadyCreated: boolean,
  recoveryIdentity?: RecoveryRecord,
): Promise<void> {
  let identity:
    | { readonly remoteId: string; readonly head: string }
    | undefined;
  if (!remoteAlreadyCreated) {
    const created = await run(runner, {
      tool: "gh",
      args: [
        "repo",
        "create",
        `${target.owner}/${target.repo}`,
        target.visibility === "public" ? "--public" : "--private",
        "--source",
        ".",
        "--remote",
        "origin",
      ],
      cwd: projectDirectory,
      timeoutMs: 300_000,
      maxOutputBytes: 65_536,
    });
    if (!commandSucceeded(created)) {
      throw processFailure(
        created,
        "SERVER_GITHUB_CREATE_FAILED",
        "CHECK_GITHUB_ACCESS",
      );
    }
    const view = await preflightGithub(runner, projectDirectory, target, true);
    const head = await readLocalHead(runner, projectDirectory);
    if (
      view === null ||
      head === null ||
      !matchingGithubRemote(await localRemote(runner, projectDirectory), target)
    ) {
      throw serverError(
        "SERVER_GITHUB_RECOVERY_CONFLICT",
        "INSPECT_GITHUB_REPOSITORY",
      );
    }
    identity = { remoteId: view.id, head };
    await writeRecovery(projectDirectory, "remote-created", target, identity);
  } else if (recoveryIdentity !== undefined) {
    identity = {
      remoteId: recoveryIdentity.remoteId,
      head: recoveryIdentity.head,
    };
  }

  if (identity === undefined) {
    throw serverError(
      "SERVER_GITHUB_RECOVERY_CONFLICT",
      "INSPECT_GITHUB_REPOSITORY",
    );
  }

  const beforePushView = await preflightGithub(
    runner,
    projectDirectory,
    target,
    true,
  );
  const localHead = await readLocalHead(runner, projectDirectory);
  const branchHead = await remoteBranchHead(runner, projectDirectory);
  if (
    beforePushView === null ||
    beforePushView.id !== identity.remoteId ||
    localHead === null ||
    localHead.toLowerCase() !== identity.head.toLowerCase() ||
    (branchHead !== null &&
      branchHead.toLowerCase() !== identity.head.toLowerCase())
  ) {
    throw serverError(
      "SERVER_GITHUB_RECOVERY_CONFLICT",
      "INSPECT_GITHUB_REPOSITORY",
    );
  }

  const pushed = await run(runner, {
    tool: "git",
    args: ["push", "--set-upstream", "origin", "main"],
    cwd: projectDirectory,
    timeoutMs: 300_000,
    maxOutputBytes: 65_536,
  });
  if (!commandSucceeded(pushed)) {
    throw serverError(
      "SERVER_GITHUB_PUSH_FAILED",
      "RETRY_INIT",
      EXIT_CODE.FAILURE,
    );
  }
  const view = await preflightGithub(runner, projectDirectory, target, true);
  if (view === null) {
    throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
  }
  const head = await verifyPushedHead(runner, projectDirectory);
  if (view.id !== identity.remoteId || head !== identity.head) {
    throw serverError(
      "SERVER_GITHUB_RECOVERY_CONFLICT",
      "INSPECT_GITHUB_REPOSITORY",
    );
  }
  await writeRecovery(projectDirectory, "complete", target, {
    remoteId: identity.remoteId,
    head: identity.head,
  });
}

async function attachGithub(
  runner: ProcessRunner,
  cwd: string,
  projectDirectory: string,
  config: ServerConfig,
  target: GithubTarget,
  recognized: boolean,
): Promise<ServerInitResult> {
  const recovery = recognized ? await loadRecovery(projectDirectory) : null;
  const remote = recognized ? await localRemote(runner, projectDirectory) : null;

  if (recovery !== null) {
    if (
      recovery.github.owner !== target.owner ||
      recovery.github.repo !== target.repo ||
      recovery.github.visibility !== target.visibility
    ) {
      throw serverError("SERVER_RECOVERY_CONFLICT", "INSPECT_PROJECT_STATE");
    }
    if (recovery.step === "complete") {
      const view = await preflightGithub(runner, cwd, target, true);
      if (
        view === null ||
        view.id !== recovery.remoteId ||
        !matchingGithubRemote(remote, target)
      ) {
        throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
      }
      const head = await verifyPushedHead(runner, projectDirectory);
      if (head !== recovery.head) {
        throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
      }
      return {
        subcommand: "init",
        status: "unchanged",
        projectDirectory,
        projectId: config.projectId,
        github: { ...target, pushed: true },
      };
    }
    if (!matchingGithubRemote(remote, target)) {
      throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_GITHUB_REPOSITORY");
    }
    await createAndPushRemote(
      runner,
      projectDirectory,
      target,
      true,
      recovery,
    );
    return {
      subcommand: "init",
      status: "unchanged",
      projectDirectory,
      projectId: config.projectId,
      github: { ...target, pushed: true },
    };
  }

  if (recognized && matchingGithubRemote(remote, target)) {
    await preflightGithub(runner, cwd, target, true);
    return {
      subcommand: "init",
      status: "unchanged",
      projectDirectory,
      projectId: config.projectId,
      github: { ...target, pushed: false },
    };
  }
  if (remote !== null) {
    throw serverError("SERVER_GITHUB_RECOVERY_CONFLICT", "INSPECT_PROJECT_REMOTE");
  }

  await preflightGithub(runner, cwd, target, false);
  await createAndPushRemote(runner, projectDirectory, target, false);
  return {
    subcommand: "init",
    status: recognized ? "unchanged" : "initialized",
    projectDirectory,
    projectId: config.projectId,
    github: { ...target, pushed: true },
  };
}

export async function runServerInit(
  dependencies: InitDependencies,
  options: ServerInitOptions,
): Promise<ServerInitResult> {
  if (options.projectDirectory !== undefined && options.directory !== undefined) {
    throw serverError("SERVER_PROJECT_AMBIGUOUS", "CHOOSE_PROJECT_DIRECTORY");
  }
  const projectDirectory = resolveServerProject(
    dependencies.io.cwd,
    options.projectDirectory ?? options.directory,
  );
  const target =
    options.github === undefined
      ? undefined
      : parseGithubTarget(options.github, options.visibility ?? "private");
  const destination = await inspectDestination(projectDirectory);
  if (destination.kind === "conflict") {
    throw serverError("SERVER_PROJECT_CONFLICT", "CHOOSE_EMPTY_DIRECTORY");
  }

  if (destination.kind === "recognized" && target === undefined) {
    return {
      subcommand: "init",
      status: "unchanged",
      projectDirectory,
      projectId: destination.config.projectId,
      github: null,
    };
  }

  await preflightGit(dependencies.runner, dependencies.io.cwd);
  if (target !== undefined && destination.kind !== "recognized") {
    await preflightGithub(
      dependencies.runner,
      dependencies.io.cwd,
      target,
      false,
    );
  }

  if (destination.kind === "recognized") {
    if (target === undefined) {
      throw serverError("SERVER_PROJECT_CONFLICT", "INSPECT_PROJECT_FILES");
    }
    return await attachGithub(
      dependencies.runner,
      dependencies.io.cwd,
      projectDirectory,
      destination.config,
      target,
      true,
    );
  }

  let record: InitRecord;
  if (destination.kind === "partial") {
    record = destination.record;
    if (record.phase === "prepared") {
      await writeMissingTemplates(projectDirectory, record);
      record = { ...record, phase: "generated" };
      await writeInitRecord(projectDirectory, record);
    }
    if (record.phase === "generated" || record.phase === "installing") {
      record = await installPinnedPackages(
        dependencies.runner,
        projectDirectory,
        record,
      );
    }
    if (record.phase === "installed" || record.phase === "committing") {
      record = await createInitialCommit(
        dependencies.runner,
        projectDirectory,
        record,
      );
    }
  } else {
    const projectId = (dependencies.randomUUID ?? randomUUID)();
    record = await initializeGeneratedProject(projectDirectory, projectId);
    record = await installPinnedPackages(
      dependencies.runner,
      projectDirectory,
      record,
    );
    record = await createInitialCommit(
      dependencies.runner,
      projectDirectory,
      record,
    );
  }
  const config = await loadServerConfig(projectDirectory);

  if (target !== undefined) {
    await createAndPushRemote(dependencies.runner, projectDirectory, target, false);
  }

  return {
    subcommand: "init",
    status: destination.kind === "partial" ? "unchanged" : "initialized",
    projectDirectory,
    projectId: record.projectId,
    github: target === undefined ? null : { ...target, pushed: true },
  };
}
