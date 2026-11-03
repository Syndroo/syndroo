import { randomBytes as systemRandomBytes } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  generateCiBearer,
  loadCiState,
  saveCiStateLocked,
  type ServerCiState,
} from "./ci-state.js";
import {
  createCloudflareApi,
  resolveCloudflareSession,
} from "./cloudflare.js";
import { loadServerConfig } from "./config.js";
import {
  loadDeploymentState,
  withDeploymentStateLock,
  type DeploymentState,
} from "./deployment-state.js";
import {
  SERVER_DEPENDENCY_VERSIONS,
  readProjectText,
} from "./foundation.js";
import { parseGithubTarget, type GithubTarget } from "./init.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process.js";

const WORKFLOW_PATH = ".github/workflows/threads-publish.yml";
const GITHUB_ENVIRONMENT = "threads-ci";
const WRANGLER_ENVIRONMENT = {
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
} as const;
const CONNECTION_ID = /^conn_[A-Za-z0-9._:-]{1,123}$/;
const GITHUB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CI_BEARER = /^[A-Za-z0-9._~+/-]{32,1024}$/;

export const SERVER_CI_WORKFLOW = `name: Publish to Threads

on:
  workflow_dispatch:
    inputs:
      post_path:
        description: Repository-relative post JSON path
        required: true
        default: posts/hello.json
      request_id:
        description: Stable logical publication id; reuse it when retrying
        required: true

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: threads-ci
    steps:
      - name: Check out repository
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
      - name: Set up Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: "24"
          package-manager-cache: false
      - name: Install pinned dependencies
        run: npm ci
      - name: Publish one Threads post
        env:
          INPUT_PATH: \${{ inputs.post_path }}
          REQUEST_ID: \${{ inputs.request_id }}
          SYNDROO_URL: \${{ vars.SYNDROO_URL }}
          SYNDROO_CONNECTION_ID: \${{ secrets.SYNDROO_CONNECTION_ID }}
          SYNDROO_TOKEN: \${{ secrets.SYNDROO_TOKEN }}
        run: >-
          npx --no-install syndroo server publish threads
          --input "$INPUT_PATH"
          --request-id "$REQUEST_ID"
          --yes --json
`;

export type ServerGithubCiDependencies = {
  readonly cwd: string;
  readonly projectDirectory?: string;
  readonly stateRoot: string;
  readonly runner: ProcessRunner;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => string;
};

export type ServerGithubCiOptions = {
  readonly repo?: string;
  readonly ciBearer?: string;
  readonly yes: boolean;
};

export type ServerGithubCiResult = {
  readonly subcommand: "ci";
  readonly status: "configured";
  readonly repository: string;
  readonly repositoryId: string;
  readonly workflow: "created" | "unchanged";
  readonly ciConnectionId: string;
  readonly workerName: string;
  readonly workerTag: string;
};

function ciError(
  code: string,
  nextAction: string,
  exitCode: ExitCode = EXIT_CODE.USAGE,
  extra: Readonly<Record<string, unknown>> = {},
): CliError {
  return new CliError(code, {
    code,
    exitCode,
    details: { ...extra, nextAction },
  });
}

type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

function processFailure(result: ProcessResult, code: string, action: string): CliError {
  return ciError(
    result.status === "spawn_error" ? "SERVER_CI_TOOL_MISSING" : code,
    result.status === "spawn_error" ? "INSTALL_REQUIRED_TOOL" : action,
    result.status === "spawn_error" ? EXIT_CODE.USAGE : EXIT_CODE.FAILURE,
  );
}

async function runChecked(
  runner: ProcessRunner,
  request: ProcessRequest,
  code: string,
  action: string,
): Promise<ProcessResult> {
  const result = await runner.run(request);
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw processFailure(result, code, action);
  }
  return result;
}

function parseTargetRemote(remote: string): GithubTarget {
  const normalized = remote.trim().toLowerCase().replace(/\.git$/, "");
  const prefixes = [
    "https://github.com/",
    "git@github.com:",
    "ssh://git@github.com/",
    "ssh://git@github.com:22/",
  ];
  const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
  if (prefix === undefined) {
    throw ciError("SERVER_CI_GITHUB_TARGET_REQUIRED", "PROVIDE_GITHUB_REPOSITORY");
  }
  return parseGithubTarget(normalized.slice(prefix.length), "private");
}

async function resolveTarget(
  runner: ProcessRunner,
  cwd: string,
  explicit: string | undefined,
): Promise<GithubTarget> {
  if (explicit !== undefined) return parseGithubTarget(explicit, "private");
  const result = await runner.run({
    tool: "git",
    args: ["remote", "get-url", "origin"],
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 8_192,
  });
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw ciError("SERVER_CI_GITHUB_TARGET_REQUIRED", "PROVIDE_GITHUB_REPOSITORY");
  }
  return parseTargetRemote(result.stdout);
}

type GithubRepository = {
  readonly id: string;
  readonly nameWithOwner: string;
  readonly url: string;
};

function parseGithubRepository(text: string, target: GithubTarget): GithubRepository {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw ciError("SERVER_CI_GITHUB_RESPONSE_INVALID", "CHECK_GITHUB_CLI");
  }
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !GITHUB_ID.test((value as { id: string }).id) ||
    typeof (value as { nameWithOwner?: unknown }).nameWithOwner !== "string" ||
    typeof (value as { url?: unknown }).url !== "string"
  ) {
    throw ciError("SERVER_CI_GITHUB_RESPONSE_INVALID", "CHECK_GITHUB_CLI");
  }
  const repository = value as { id: string; nameWithOwner: string; url: string };
  const expected = `${target.owner}/${target.repo}`;
  if (repository.nameWithOwner.toLowerCase() !== expected.toLowerCase()) {
    throw ciError("SERVER_CI_GITHUB_IDENTITY_MISMATCH", "VERIFY_GITHUB_REPOSITORY");
  }
  return repository;
}

async function verifyGithubRepository(
  runner: ProcessRunner,
  cwd: string,
  target: GithubTarget,
): Promise<GithubRepository> {
  const name = `${target.owner}/${target.repo}`;
  const result = await runChecked(
    runner,
    {
      tool: "gh",
      args: [
        "repo",
        "view",
        name,
        "--json",
        "id,nameWithOwner,isPrivate,url",
      ],
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    },
    "SERVER_CI_GITHUB_UNAVAILABLE",
    "AUTHENTICATE_GITHUB_CLI",
  );
  return parseGithubRepository(result.stdout, target);
}

async function validateProject(
  projectDirectory: string,
): Promise<{
  readonly projectId: string;
  readonly origin: string;
  readonly connectionId: string;
}> {
  const loaded = await loadServerConfig(projectDirectory);
  if (loaded.config.publicOrigin === undefined) {
    throw ciError("SERVER_CI_DEPLOYMENT_REQUIRED", "DEPLOY_SERVER_FIRST");
  }
  const connectionId = loaded.config.threads?.connectionId;
  if (connectionId === undefined || !CONNECTION_ID.test(connectionId)) {
    throw ciError("SERVER_CI_CONNECTION_REQUIRED", "CONNECT_THREADS_FIRST");
  }
  const packageText = await readProjectText(path.join(projectDirectory, "package.json"));
  if (packageText === null) {
    throw ciError("SERVER_CI_PACKAGE_INVALID", "RUN_SERVER_DOCTOR");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageText);
  } catch {
    throw ciError("SERVER_CI_PACKAGE_INVALID", "RUN_SERVER_DOCTOR");
  }
  if (
    typeof manifest !== "object" || manifest === null ||
    (manifest as { private?: unknown }).private !== true ||
    (manifest as { dependencies?: Record<string, unknown> }).dependencies?.["@syndroo/cli"] !==
      SERVER_DEPENDENCY_VERSIONS.cli ||
    (manifest as { devDependencies?: Record<string, unknown> }).devDependencies?.["wrangler"] !==
      SERVER_DEPENDENCY_VERSIONS.wrangler
  ) {
    throw ciError("SERVER_CI_PACKAGE_INVALID", "RUN_SERVER_DOCTOR");
  }
  return {
    projectId: loaded.config.projectId,
    origin: loaded.config.publicOrigin,
    connectionId,
  };
}

async function loadDeployedState(
  stateRoot: string,
  projectId: string,
  origin: string,
): Promise<DeploymentState> {
  const state = await loadDeploymentState(stateRoot, projectId);
  if (
    state === null || state.step !== "deployed" ||
    state.origin !== origin || state.worker === undefined ||
    state.versionId === undefined
  ) {
    throw ciError("SERVER_CI_DEPLOYMENT_MISMATCH", "RUN_SERVER_DOCTOR");
  }
  return state;
}

function workflowDirectoryParts(projectDirectory: string, directory: string): string[] {
  const relative = path.relative(projectDirectory, directory);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => part === "..")
  ) {
    throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
  }
  return relative === "" ? [] : relative.split(path.sep);
}

async function checkDirectoryComponent(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof CliError) throw error;
    throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
  }
}

async function validateExistingWorkflowPath(
  projectDirectory: string,
  directory: string,
): Promise<void> {
  if (!await checkDirectoryComponent(projectDirectory)) {
    throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
  }
  let cursor = projectDirectory;
  for (const part of workflowDirectoryParts(projectDirectory, directory)) {
    cursor = path.join(cursor, part);
    if (!await checkDirectoryComponent(cursor)) return;
  }
}

async function ensureDirectoryWithoutSymlink(
  projectDirectory: string,
  directory: string,
): Promise<void> {
  if (!await checkDirectoryComponent(projectDirectory)) {
    throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
  }
  let cursor = projectDirectory;
  for (const part of workflowDirectoryParts(projectDirectory, directory)) {
    cursor = path.join(cursor, part);
    if (await checkDirectoryComponent(cursor)) continue;
    try {
      await fs.mkdir(cursor, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw ciError("SERVER_CI_WORKFLOW_WRITE_FAILED", "INSPECT_PROJECT_FILES");
      }
    }
    if (!await checkDirectoryComponent(cursor)) {
      throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
    }
  }
}

async function readWorkflow(
  projectDirectory: string,
): Promise<string | null> {
  const target = path.join(projectDirectory, WORKFLOW_PATH);
  try {
    return await readProjectText(target);
  } catch {
    throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "INSPECT_WORKFLOW_PATH");
  }
}

async function inspectWorkflow(
  projectDirectory: string,
): Promise<"created" | "unchanged"> {
  const target = path.join(projectDirectory, WORKFLOW_PATH);
  await validateExistingWorkflowPath(projectDirectory, path.dirname(target));
  const existing = await readWorkflow(projectDirectory);
  if (existing === null) return "created";
  if (existing !== SERVER_CI_WORKFLOW) {
    throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "DIFF_MANAGED_WORKFLOW");
  }
  return "unchanged";
}

async function installWorkflow(
  projectDirectory: string,
): Promise<"created" | "unchanged"> {
  const target = path.join(projectDirectory, WORKFLOW_PATH);
  const directory = path.dirname(target);
  await ensureDirectoryWithoutSymlink(projectDirectory, directory);
  const existing = await readWorkflow(projectDirectory);
  if (existing !== null) {
    if (existing !== SERVER_CI_WORKFLOW) {
      throw ciError("SERVER_CI_WORKFLOW_CONFLICT", "DIFF_MANAGED_WORKFLOW");
    }
    return "unchanged";
  }
  const temporary = path.join(
    directory,
    `.threads-publish.${Buffer.from(systemRandomBytes(8)).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      temporary,
      FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(SERVER_CI_WORKFLOW);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
    return "created";
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw ciError("SERVER_CI_WORKFLOW_WRITE_FAILED", "INSPECT_PROJECT_FILES");
  }
}

function parseSecretNames(result: ProcessResult): Set<string> {
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw processFailure(
      result,
      "SERVER_CI_CLOUDFLARE_UNAVAILABLE",
      "AUTHENTICATE_CLOUDFLARE",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw ciError("SERVER_CI_CLOUDFLARE_RESPONSE_INVALID", "CHECK_WRANGLER_OUTPUT");
  }
  if (!Array.isArray(value)) {
    throw ciError("SERVER_CI_CLOUDFLARE_RESPONSE_INVALID", "CHECK_WRANGLER_OUTPUT");
  }
  const names = new Set<string>();
  for (const entry of value) {
    const name = typeof entry === "string"
      ? entry
      : typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string"
        ? (entry as { name: string }).name
        : undefined;
    if (name === undefined || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw ciError("SERVER_CI_CLOUDFLARE_RESPONSE_INVALID", "CHECK_WRANGLER_OUTPUT");
    }
    names.add(name);
  }
  return names;
}

async function listCloudflareSecrets(
  runner: ProcessRunner,
  projectDirectory: string,
  workerName: string,
  accountId: string,
  configFile: string,
): Promise<Set<string>> {
  const result = await runner.run({
    tool: "wrangler",
    args: [
      "secret",
      "list",
      "--name",
      workerName,
      "--config",
      configFile,
      "--format",
      "json",
    ],
    cwd: projectDirectory,
    environment: {
      ...WRANGLER_ENVIRONMENT,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
  });
  return parseSecretNames(result);
}

async function verifyCloudflareIdentity(
  dependencies: ServerGithubCiDependencies,
  projectDirectory: string,
  deployment: DeploymentState,
  configFile: string,
): Promise<void> {
  const session = await resolveCloudflareSession(
    dependencies.runner,
    projectDirectory,
    dependencies.env,
    deployment.accountId,
  );
  if (session.accountId !== deployment.accountId) {
    throw ciError("SERVER_CI_CLOUDFLARE_IDENTITY_MISMATCH", "SELECT_CLOUDFLARE_ACCOUNT");
  }
  const worker = await createCloudflareApi({
    accountId: session.accountId,
    token: session.token,
    fetch: dependencies.fetch ?? globalThis.fetch,
  }).worker(deployment.workerName);
  if (worker === null || worker.tag !== deployment.worker?.tag) {
    throw ciError("SERVER_CI_CLOUDFLARE_IDENTITY_MISMATCH", "RUN_SERVER_DOCTOR");
  }
  const effective = await readProjectText(configFile);
  if (effective === null) {
    throw ciError("SERVER_CI_CLOUDFLARE_CONFIG_INVALID", "REDEPLOY_PROJECT");
  }
}

async function ensureGithubEnvironment(
  runner: ProcessRunner,
  cwd: string,
  repository: string,
): Promise<void> {
  const existing = await runner.run({
    tool: "gh",
    args: [
      "api",
      "--include",
      `repos/${repository}/environments/${GITHUB_ENVIRONMENT}`,
    ],
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
  });
  if (existing.status !== "exited") {
    throw processFailure(
      existing,
      "SERVER_CI_GITHUB_ENVIRONMENT_FAILED",
      "CHECK_GITHUB_CLI",
    );
  }
  if (existing.exitCode === 0) {
    return;
  }
  const firstLine = existing.stdout.split(/\r?\n/, 1)[0] ?? "";
  if (!/^HTTP\/[0-9.]+ 404(?:\s|$)/.test(firstLine)) {
    throw ciError(
      "SERVER_CI_GITHUB_ENVIRONMENT_FAILED",
      "CHECK_GITHUB_CREDENTIALS_AND_REPOSITORY",
      EXIT_CODE.FAILURE,
    );
  }
  await runChecked(
    runner,
    {
      tool: "gh",
      args: [
        "api",
        "--method",
        "PUT",
        `repos/${repository}/environments/${GITHUB_ENVIRONMENT}`,
      ],
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    },
    "SERVER_CI_GITHUB_ENVIRONMENT_FAILED",
    "CHECK_GITHUB_CREDENTIALS_AND_REPOSITORY",
  );
}

function assertCiStateIdentity(state: ServerCiState, projectId: string, deployment: DeploymentState): void {
  if (
    state.projectId !== projectId ||
    state.accountId !== deployment.accountId ||
    state.workerName !== deployment.workerName ||
    state.workerTag !== deployment.worker?.tag
  ) {
    throw ciError("SERVER_CI_STATE_IDENTITY_MISMATCH", "INSPECT_SERVER_STATE");
  }
}

export async function runServerGithubCi(
  dependencies: ServerGithubCiDependencies,
  options: ServerGithubCiOptions,
): Promise<ServerGithubCiResult> {
  if (!options.yes) {
    throw ciError("SERVER_CI_AUTHORIZATION_REQUIRED", "CONFIRM_CI_SETUP");
  }
  const projectDirectory = path.resolve(
    dependencies.cwd,
    dependencies.projectDirectory ?? ".",
  );
  if (options.ciBearer !== undefined && !CI_BEARER.test(options.ciBearer)) {
    throw ciError("SERVER_CI_BEARER_INVALID", "PROVIDE_CI_BEARER");
  }

  return await withDeploymentStateLock(dependencies.stateRoot, async () => {
    const project = await validateProject(projectDirectory);
    const deployment = await loadDeployedState(
      dependencies.stateRoot,
      project.projectId,
      project.origin,
    );
    if (deployment.worker === undefined) {
      throw ciError("SERVER_CI_DEPLOYMENT_MISMATCH", "RUN_SERVER_DOCTOR");
    }
    const configFile = path.join(projectDirectory, "wrangler.effective.jsonc");
    if ((await readProjectText(configFile)) === null) {
      throw ciError("SERVER_CI_CLOUDFLARE_CONFIG_INVALID", "REDEPLOY_PROJECT");
    }
    const intendedWorkflow = await inspectWorkflow(projectDirectory);
    const target = await resolveTarget(dependencies.runner, projectDirectory, options.repo);
    const repositoryName = `${target.owner}/${target.repo}`;
    const repository = await verifyGithubRepository(
      dependencies.runner,
      projectDirectory,
      target,
    );
    const ciStateBeforeValidation = await loadCiState(
      dependencies.stateRoot,
      project.projectId,
    );
    if (ciStateBeforeValidation !== null) {
      assertCiStateIdentity(
        ciStateBeforeValidation,
        project.projectId,
        deployment,
      );
      if (
        ciStateBeforeValidation.github !== undefined &&
        (ciStateBeforeValidation.github.repoId !== repository.id ||
          ciStateBeforeValidation.github.repository.toLowerCase() !==
            repositoryName.toLowerCase())
      ) {
        throw ciError("SERVER_CI_GITHUB_IDENTITY_MISMATCH", "INSPECT_CI_STATE");
      }
      if (options.ciBearer !== undefined && options.ciBearer !== ciStateBeforeValidation.bearer) {
        throw ciError("SERVER_CI_BEARER_CONFLICT", "USE_EXISTING_CI_BEARER");
      }
    }
    const workflow = intendedWorkflow === "created"
      ? await installWorkflow(projectDirectory)
      : "unchanged";
    await verifyCloudflareIdentity(
      dependencies,
      projectDirectory,
      deployment,
      configFile,
    );
    const secretNames = await listCloudflareSecrets(
      dependencies.runner,
      projectDirectory,
      deployment.workerName,
      deployment.accountId,
      configFile,
    );
    const hasBearer = secretNames.has("CI_BEARER");
    const hasConnection = secretNames.has("CI_CONNECTION_ID");
    if (hasBearer !== hasConnection) {
      throw ciError(
        "SERVER_CI_REMOTE_PAIR_INCONSISTENT",
        "INSPECT_CLOUDFLARE_SECRETS",
      );
    }

    let ciState = ciStateBeforeValidation;
    if (ciState === null && hasBearer && options.ciBearer === undefined) {
      throw ciError(
        "SERVER_CI_TOKEN_RECOVERY_REQUIRED",
        "PROVIDE_CI_BEARER",
      );
    }

    const connectionChanged =
      ciState !== null && ciState.connectionId !== project.connectionId;
    if (ciState === null) {
      ciState = {
        version: 1,
        projectId: project.projectId,
        accountId: deployment.accountId,
        workerName: deployment.workerName,
        workerTag: deployment.worker!.tag,
        connectionId: project.connectionId,
        bearer:
          options.ciBearer ??
          generateCiBearer(dependencies.randomBytes ?? systemRandomBytes),
        workerUploaded: false,
        updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      };
    } else if (connectionChanged) {
      ciState = {
        ...ciState,
        connectionId: project.connectionId,
        workerUploaded: false,
        updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      };
    }
    ciState = {
      ...ciState,
      github: {
        repoId: repository.id,
        repository: repositoryName,
        configured: false,
      },
      updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    };
    await saveCiStateLocked(dependencies.stateRoot, ciState);

    const needsWorkerUpload =
      !hasBearer || connectionChanged || !ciState.workerUploaded;
    if (needsWorkerUpload) {
      await runChecked(
        dependencies.runner,
        {
          tool: "wrangler",
          args: [
            "secret",
            "bulk",
            "--name",
            deployment.workerName,
            "--config",
            configFile,
          ],
          cwd: projectDirectory,
          stdin: Buffer.from(
            JSON.stringify({
              CI_BEARER: ciState.bearer,
              CI_CONNECTION_ID: ciState.connectionId,
            }),
          ),
          environment: {
            ...WRANGLER_ENVIRONMENT,
            CLOUDFLARE_ACCOUNT_ID: deployment.accountId,
          },
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
        },
        "SERVER_CI_CLOUDFLARE_WRITE_FAILED",
        "RETRY_CI_SETUP",
      );
      ciState = {
        ...ciState,
        workerUploaded: true,
        updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      };
      await saveCiStateLocked(dependencies.stateRoot, ciState);
    }

    await ensureGithubEnvironment(
      dependencies.runner,
      projectDirectory,
      repositoryName,
    );
    await runChecked(
      dependencies.runner,
      {
        tool: "gh",
        args: [
          "variable",
          "set",
          "SYNDROO_URL",
          "--env",
          GITHUB_ENVIRONMENT,
          "--repo",
          repositoryName,
          "--body",
          project.origin,
        ],
        cwd: projectDirectory,
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      },
      "SERVER_CI_GITHUB_VARIABLE_FAILED",
      "RETRY_CI_SETUP",
    );
    for (const [name, value] of [
      ["SYNDROO_TOKEN", ciState.bearer],
      ["SYNDROO_CONNECTION_ID", ciState.connectionId],
    ] as const) {
      await runChecked(
        dependencies.runner,
        {
          tool: "gh",
          args: [
            "secret",
            "set",
            name,
            "--env",
            GITHUB_ENVIRONMENT,
            "--repo",
            repositoryName,
          ],
          cwd: projectDirectory,
          stdin: Buffer.from(value),
          timeoutMs: 30_000,
          maxOutputBytes: 65_536,
        },
        "SERVER_CI_GITHUB_SECRET_FAILED",
        "RETRY_CI_SETUP",
      );
    }

    const configured = {
      ...ciState,
      github: {
        repoId: repository.id,
        repository: repositoryName,
        configured: true,
      },
      updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    };
    await saveCiStateLocked(dependencies.stateRoot, configured);
    return {
      subcommand: "ci" as const,
      status: "configured" as const,
      repository: repositoryName,
      repositoryId: repository.id,
      workflow,
      ciConnectionId: configured.connectionId,
      workerName: deployment.workerName,
      workerTag: deployment.worker!.tag,
    };
  });
}
