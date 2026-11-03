import { randomBytes } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parse,
  parseTree,
  type Node,
} from "jsonc-parser/lib/esm/main.js";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import { ensureStateRoot } from "../runtime/filesystem/atomic.js";
import {
  assertCloudflareApiEnvironment,
  CloudflareApiError,
  createCloudflareApi,
  resolveCloudflareSession,
  type CloudflareResource,
} from "./cloudflare.js";
import {
  loadServerConfig,
  resolveServerProject,
  updateServerConfig,
  type LoadedServerConfig,
} from "./config.js";
import {
  DEPLOYMENT_SECRET_NAMES,
  deploymentReceiptFileName,
  ensureDeploymentCredentials,
  loadDeploymentReceipt,
  loadDeploymentState,
  resolveDeploymentStateRoot,
  saveDeploymentState,
  withDeploymentStateLock,
  type DeploymentCredentials,
  type DeploymentSecretName,
  type DeploymentState,
} from "./deployment-state.js";
import {
  SERVER_DEPENDENCY_VERSIONS,
  readProjectText,
} from "./foundation.js";
import type { ProcessResult, ProcessRunner } from "./process.js";

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKER_MAIN =
  "./node_modules/@syndroo/cloudflare/dist/worker.js";
const MAX_DEPLOY_OUTPUT_BYTES = 1_048_576;
const WRANGLER_OUTPUT_KEY = "WRANGLER_OUTPUT_FILE_PATH";
const WRANGLER_ENVIRONMENT = { WRANGLER_SEND_METRICS: "false" } as const;

export type ServerDeployDependencies = {
  readonly cwd: string;
  readonly runner: ProcessRunner;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly stateRoot?: string;
  readonly randomBytes?: (size: number) => Uint8Array;
};

export type ServerDeployOptions = {
  readonly projectDirectory?: string;
  readonly account?: string;
  readonly authorized: boolean;
  readonly credentials?: Partial<DeploymentCredentials>;
  readonly readCredential?: (
    name: DeploymentSecretName,
  ) => Promise<string | undefined>;
  readonly recover?: ServerDeployRecovery;
};

export type ServerDeployRecovery = {
  readonly d1Id?: string;
  readonly queues?: Readonly<Record<string, string>>;
  readonly workerTag?: string;
  readonly versionId?: string;
};

export type ServerDeployResult = {
  readonly subcommand: "deploy";
  readonly status: "deployed";
  readonly projectDirectory: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly origin: string;
  readonly versionId: string;
  readonly workerTag: string;
  readonly resources: {
    readonly d1: { readonly name: string; readonly id: string };
    readonly queues: readonly {
      readonly name: string;
      readonly id: string;
    }[];
  };
};

type WranglerProject = {
  readonly raw: Record<string, unknown>;
  readonly workerName: string;
  readonly d1Name: string;
  readonly workQueueName: string;
  readonly deadQueueName: string;
  readonly queueNames: readonly string[];
  readonly workersDev: boolean;
};

type DeployRecord = {
  readonly workerTag: string;
  readonly versionId: string;
  readonly targets: readonly string[];
};

type WorkerEvidence = Pick<DeployRecord, "workerTag" | "versionId">;

function deployError(
  code: string,
  nextAction?: string,
  exitCode: ExitCode = EXIT_CODE.FAILURE,
  details: Readonly<Record<string, unknown>> = {},
): CliError {
  return new CliError(code, {
    code,
    exitCode,
    details: {
      ...details,
      ...(nextAction === undefined ? {} : { nextAction }),
    },
  });
}

type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyName(node: Node): string | undefined {
  const key = node.children?.[0];
  return typeof key?.value === "string" ? key.value : undefined;
}

function rejectDuplicateProperties(node: Node): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const child of node.children ?? []) {
      const name = propertyName(child);
      if (name === undefined || seen.has(name)) {
        throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
      }
      seen.add(name);
      const value = child.children?.[1];
      if (value === undefined) {
        throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
      }
      rejectDuplicateProperties(value);
    }
  } else if (node.type === "array") {
    for (const child of node.children ?? []) {
      rejectDuplicateProperties(child);
    }
  }
}

function parseWranglerProject(text: string): WranglerProject {
  const errors: Parameters<typeof parse>[1] = [];
  const parsed = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const tree = parseTree(text, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || tree === undefined || !isRecord(parsed)) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  rejectDuplicateProperties(tree);

  const workerName = parsed["name"];
  if (typeof workerName !== "string" || !WORKER_NAME.test(workerName)) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const main = parsed["main"];
  if (main !== WORKER_MAIN) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  if (
    !Array.isArray(parsed["d1_databases"]) ||
    parsed["d1_databases"].length !== 1 ||
    !isRecord(parsed["d1_databases"][0]) ||
    parsed["d1_databases"][0]["binding"] !== "DB" ||
    typeof parsed["d1_databases"][0]["database_name"] !== "string" ||
    !RESOURCE_NAME.test(parsed["d1_databases"][0]["database_name"] as string)
  ) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const d1Name = parsed["d1_databases"][0]["database_name"] as string;

  if (!isRecord(parsed["queues"])) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const producers = parsed["queues"]["producers"];
  if (
    !Array.isArray(producers) ||
    producers.length !== 1 ||
    !isRecord(producers[0]) ||
    producers[0]["binding"] !== "WORK_QUEUE" ||
    typeof producers[0]["queue"] !== "string" ||
    !RESOURCE_NAME.test(producers[0]["queue"])
  ) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const workQueueName = producers[0]["queue"] as string;
  const consumers = parsed["queues"]["consumers"];
  if (
    !Array.isArray(consumers) ||
    consumers.length !== 2 ||
    consumers.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry["queue"] !== "string" ||
        !RESOURCE_NAME.test(entry["queue"]),
    )
  ) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const consumerNames = consumers.map(
    (entry) => (entry as { queue: string }).queue,
  );
  if (
    new Set(consumerNames).size !== 2 ||
    !consumerNames.includes(workQueueName)
  ) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const deadQueueName = consumerNames.find(
    (name) => name !== workQueueName,
  ) as string;

  const vars = parsed["vars"];
  const compatibilityFlags = parsed["compatibility_flags"];
  const secrets = parsed["secrets"];
  const requiredSecrets =
    isRecord(secrets) && Array.isArray(secrets["required"])
      ? secrets["required"]
      : undefined;
  if (
    !isRecord(vars) ||
    vars["PUBLIC_FETCH_STRICT"] !== "enabled" ||
    !Array.isArray(compatibilityFlags) ||
    !compatibilityFlags.includes("global_fetch_strictly_public") ||
    requiredSecrets === undefined ||
    !DEPLOYMENT_SECRET_NAMES.every((name) =>
      requiredSecrets.includes(name),
    )
  ) {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }
  const workersDev = parsed["workers_dev"] ?? true;
  if (typeof workersDev !== "boolean") {
    throw deployError("SERVER_DEPLOY_CONFIG_INVALID", "FIX_WRANGLER_CONFIG");
  }

  return {
    raw: parsed,
    workerName,
    d1Name,
    workQueueName,
    deadQueueName,
    queueNames: [workQueueName, deadQueueName],
    workersDev,
  };
}

function validateRecovery(
  value: ServerDeployRecovery | undefined,
  project: WranglerProject,
): ServerDeployRecovery | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw deployError(
      "SERVER_DEPLOY_RECOVERY_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
      EXIT_CODE.USAGE,
    );
  }
  const allowed = new Set(["d1Id", "queues", "workerTag", "versionId"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw deployError(
      "SERVER_DEPLOY_RECOVERY_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
      EXIT_CODE.USAGE,
    );
  }
  if (value.d1Id !== undefined && !RESOURCE_NAME.test(value.d1Id)) {
    throw deployError(
      "SERVER_DEPLOY_RECOVERY_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
      EXIT_CODE.USAGE,
    );
  }
  if (
    value.queues !== undefined &&
    (!isRecord(value.queues) ||
      Object.entries(value.queues).some(
        ([name, id]) =>
          !project.queueNames.includes(name) ||
          typeof id !== "string" ||
          !RESOURCE_NAME.test(id),
      ))
  ) {
    throw deployError(
      "SERVER_DEPLOY_RECOVERY_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
      EXIT_CODE.USAGE,
    );
  }
  if (
    (value.workerTag === undefined) !== (value.versionId === undefined) ||
    (value.workerTag !== undefined &&
      (typeof value.workerTag !== "string" ||
        !RESOURCE_NAME.test(value.workerTag))) ||
    (value.versionId !== undefined &&
      (typeof value.versionId !== "string" ||
        !RESOURCE_NAME.test(value.versionId)))
  ) {
    throw deployError(
      "SERVER_DEPLOY_RECOVERY_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

function selectedAccount(
  dependencies: ServerDeployDependencies,
  options: ServerDeployOptions,
  project: WranglerProject,
  state: DeploymentState | null,
): string | undefined {
  const wranglerAccount = project.raw["account_id"];
  if (
    wranglerAccount !== undefined &&
    (typeof wranglerAccount !== "string" ||
      !RESOURCE_NAME.test(wranglerAccount))
  ) {
    throw deployError(
      "SERVER_DEPLOY_ACCOUNT_CONFLICT",
      "USE_ONE_CLOUDFLARE_ACCOUNT",
      EXIT_CODE.USAGE,
    );
  }
  const configured = [
    wranglerAccount,
    dependencies.env["CLOUDFLARE_ACCOUNT_ID"],
  ].filter((value): value is string => value !== undefined && value !== "");
  if (
    configured.some(
      (value) => typeof value !== "string" || !RESOURCE_NAME.test(value),
    ) ||
    new Set(configured).size > 1
  ) {
    throw deployError(
      "SERVER_DEPLOY_ACCOUNT_CONFLICT",
      "USE_ONE_CLOUDFLARE_ACCOUNT",
      EXIT_CODE.USAGE,
    );
  }
  return options.account ?? configured[0] ?? state?.accountId;
}

async function readWranglerProject(
  projectDirectory: string,
): Promise<WranglerProject> {
  let text: string | null;
  try {
    text = await readProjectText(path.join(projectDirectory, "wrangler.jsonc"));
  } catch {
    throw deployError(
      "SERVER_DEPLOY_CONFIG_INVALID",
      "FIX_WRANGLER_CONFIG",
      EXIT_CODE.USAGE,
    );
  }
  if (text === null) {
    throw deployError(
      "SERVER_DEPLOY_CONFIG_INVALID",
      "FIX_WRANGLER_CONFIG",
      EXIT_CODE.USAGE,
    );
  }
  return parseWranglerProject(text);
}

function exactPackageVersion(manifest: unknown): boolean {
  if (!isRecord(manifest)) {
    return false;
  }
  return (
    manifest["private"] === true &&
    JSON.stringify(manifest["syndroo"]) ===
      JSON.stringify({ generated: true, server: 1 }) &&
    isRecord(manifest["dependencies"]) &&
    manifest["dependencies"]["@syndroo/cli"] ===
      SERVER_DEPENDENCY_VERSIONS.cli &&
    manifest["dependencies"]["@syndroo/cloudflare"] ===
      SERVER_DEPENDENCY_VERSIONS.cloudflare &&
    isRecord(manifest["devDependencies"]) &&
    manifest["devDependencies"]["wrangler"] ===
      SERVER_DEPENDENCY_VERSIONS.wrangler
  );
}

async function validatePinnedWrangler(projectDirectory: string): Promise<void> {
  const packageText = await readProjectText(path.join(projectDirectory, "package.json"));
  let packageManifest: unknown;
  try {
    packageManifest = packageText === null ? null : JSON.parse(packageText);
  } catch {
    packageManifest = null;
  }
  if (!exactPackageVersion(packageManifest)) {
    throw deployError(
      "SERVER_DEPLOY_PACKAGE_INVALID",
      "REINSTALL_GENERATED_DEPENDENCIES",
      EXIT_CODE.USAGE,
    );
  }

  const installedText = await readProjectText(
    path.join(projectDirectory, "node_modules", "wrangler", "package.json"),
  );
  let installed: unknown;
  try {
    installed = installedText === null ? null : JSON.parse(installedText);
  } catch {
    installed = null;
  }
  if (
    !isRecord(installed) ||
    installed["version"] !== SERVER_DEPENDENCY_VERSIONS.wrangler
  ) {
    throw deployError(
      "SERVER_DEPLOY_WRANGLER_INVALID",
      "INSTALL_PROJECT_WRANGLER",
      EXIT_CODE.USAGE,
    );
  }

  const binary = path.join(projectDirectory, "node_modules", ".bin", "wrangler");
  let binaryTarget = binary;
  try {
    const stat = await fs.lstat(binary);
    if (stat.isSymbolicLink()) {
      binaryTarget = await fs.realpath(binary);
    } else if (!stat.isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw deployError(
      "SERVER_DEPLOY_WRANGLER_INVALID",
      "INSTALL_PROJECT_WRANGLER",
      EXIT_CODE.USAGE,
    );
  }
  const modules = path.join(projectDirectory, "node_modules") + path.sep;
  if (!binaryTarget.startsWith(modules)) {
    throw deployError(
      "SERVER_DEPLOY_WRANGLER_INVALID",
      "REINSTALL_GENERATED_DEPENDENCIES",
      EXIT_CODE.USAGE,
    );
  }

  let ignoreText: string | null;
  try {
    ignoreText = await readProjectText(path.join(projectDirectory, ".gitignore"));
  } catch {
    ignoreText = null;
  }
  if (
    ignoreText === null ||
    !ignoreText
      .split(/\r?\n/)
      .some((line) => line.trim() === "wrangler.effective.jsonc")
  ) {
    throw deployError(
      "SERVER_DEPLOY_CONFIG_INVALID",
      "IGNORE_GENERATED_WRANGLER_CONFIG",
      EXIT_CODE.USAGE,
    );
  }
}

function processFailure(
  result: ProcessResult,
  code: string,
  nextAction: string,
): CliError {
  if (result.status === "spawn_error") {
    return deployError(code, nextAction, EXIT_CODE.USAGE);
  }
  if (result.status === "timed_out") {
    return deployError("SERVER_DEPLOY_AMBIGUOUS", "INSPECT_DEPLOYMENT");
  }
  if (result.status === "output_limit") {
    return deployError("SERVER_DEPLOY_OUTPUT_LIMIT", "RETRY_DEPLOY");
  }
  return deployError(code, nextAction);
}

async function verifyWranglerVersion(
  runner: ProcessRunner,
  projectDirectory: string,
): Promise<void> {
  const result = await runner.run({
    tool: "wrangler",
    args: ["--version"],
    cwd: projectDirectory,
    environment: WRANGLER_ENVIRONMENT,
    timeoutMs: 30_000,
    maxOutputBytes: 16_384,
  });
  if (
    result.status !== "exited" ||
    result.exitCode !== 0 ||
    !result.stdout.includes(SERVER_DEPENDENCY_VERSIONS.wrangler)
  ) {
    throw processFailure(
      result,
      "SERVER_DEPLOY_WRANGLER_INVALID",
      "INSTALL_PROJECT_WRANGLER",
    );
  }
}

function newState(
  loaded: LoadedServerConfig,
  project: WranglerProject,
  accountId: string,
  now: string,
  operationId: string,
): DeploymentState {
  return {
    version: 1,
    projectId: loaded.config.projectId,
    accountId,
    workerName: project.workerName,
    step: "planned",
    operationId,
    resources: {
      d1: { name: project.d1Name },
      queues: project.queueNames.map((name) => ({ name })),
    },
    updatedAt: now,
  };
}

function assertStateIdentity(
  state: DeploymentState,
  loaded: LoadedServerConfig,
  project: WranglerProject,
  accountId: string,
): void {
  if (state.projectId !== loaded.config.projectId) {
    throw deployError("SERVER_DEPLOY_OWNERSHIP_UNVERIFIED", "INSPECT_SERVER_STATE");
  }
  if (state.accountId !== accountId || state.workerName !== project.workerName) {
    throw deployError(
      "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      "INSPECT_SERVER_STATE",
    );
  }
  const names = state.resources.queues.map((queue) => queue.name);
  if (
    state.resources.d1.name !== project.d1Name ||
    names.length !== project.queueNames.length ||
    names.some((name, index) => name !== project.queueNames[index])
  ) {
    throw deployError(
      "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      "REVIEW_WRANGLER_CONFIG",
    );
  }
}

function reconcileThenCreateNames(
  state: DeploymentState | null,
  remoteD1: CloudflareResource | null,
  remoteQueues: ReadonlyMap<string, CloudflareResource | null>,
): {
  readonly createD1: boolean;
  readonly createQueues: readonly string[];
} {
  const stateD1 = state?.resources.d1.id;
  if (remoteD1 !== null) {
    if (stateD1 === undefined) {
      throw deployError(
        "SERVER_DEPLOY_OWNERSHIP_UNVERIFIED",
        "PROVIDE_RESOURCE_RECOVERY",
      );
    }
    if (stateD1 !== remoteD1.id) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "INSPECT_CLOUDFLARE_RESOURCES",
      );
    }
  } else if (stateD1 !== undefined) {
    throw deployError(
      "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      "INSPECT_CLOUDFLARE_RESOURCES",
    );
  }

  const createQueues: string[] = [];
  for (const [name, remote] of remoteQueues) {
    const stateQueue = state?.resources.queues.find((queue) => queue.name === name);
    if (remote !== null) {
      if (stateQueue?.id === undefined) {
        throw deployError(
          "SERVER_DEPLOY_OWNERSHIP_UNVERIFIED",
          "PROVIDE_RESOURCE_RECOVERY",
        );
      }
      if (stateQueue.id !== remote.id) {
        throw deployError(
          "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
          "INSPECT_CLOUDFLARE_RESOURCES",
        );
      }
    } else if (stateQueue?.id !== undefined) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "INSPECT_CLOUDFLARE_RESOURCES",
      );
    } else {
      createQueues.push(name);
    }
  }

  return {
    createD1: remoteD1 === null,
    createQueues,
  };
}

async function applyResourceRecovery(
  state: DeploymentState,
  recovery: ServerDeployRecovery | undefined,
  api: ReturnType<typeof createCloudflareApi>,
  remoteD1: CloudflareResource | null,
  remoteQueues: ReadonlyMap<string, CloudflareResource | null>,
  now: () => string,
): Promise<DeploymentState> {
  let d1 = state.resources.d1;
  if (recovery?.d1Id !== undefined) {
    const verified = await api.d1(recovery.d1Id);
    if (
      verified === null ||
      verified.name !== state.resources.d1.name ||
      remoteD1 === null ||
      remoteD1.id !== verified.id ||
      (d1.id !== undefined && d1.id !== verified.id)
    ) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "PROVIDE_RESOURCE_RECOVERY",
      );
    }
    d1 = { name: verified.name, id: verified.id };
  }

  const queues = [...state.resources.queues];
  for (const [name, id] of Object.entries(recovery?.queues ?? {})) {
    const verified = await api.queue(id);
    const remote = remoteQueues.get(name) ?? null;
    const index = queues.findIndex((queue) => queue.name === name);
    const existing = index === -1 ? undefined : queues[index];
    if (
      verified === null ||
      verified.name !== name ||
      remote === null ||
      remote.id !== verified.id ||
      (existing?.id !== undefined && existing.id !== verified.id)
    ) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "PROVIDE_RESOURCE_RECOVERY",
      );
    }
    queues[index] = { name, id: verified.id };
  }

  return withUpdatedState(
    state,
    { resources: { d1, queues } },
    now(),
  );
}

async function hasActiveVersion(
  runner: ProcessRunner,
  projectDirectory: string,
  workerName: string,
  versionId: string,
): Promise<boolean> {
  const result = await runner.run({
    tool: "wrangler",
    args: ["deployments", "list", "--name", workerName, "--json"],
    cwd: projectDirectory,
    environment: WRANGLER_ENVIRONMENT,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
  });
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw deployError(
      "SERVER_DEPLOY_REMOTE_READ_FAILED",
      "RERUN_DEPLOY_TO_RECONCILE",
    );
  }
  let deployments: unknown;
  try {
    deployments = JSON.parse(result.stdout);
  } catch {
    throw deployError(
      "SERVER_DEPLOY_REMOTE_READ_FAILED",
      "RERUN_DEPLOY_TO_RECONCILE",
    );
  }
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return false;
  }
  const latest = deployments[0];
  return (
    isRecord(latest) &&
    Array.isArray(latest["versions"]) &&
    latest["versions"].some(
      (entry) =>
        isRecord(entry) &&
        entry["version_id"] === versionId &&
        typeof entry["percentage"] === "number" &&
        entry["percentage"] > 0,
    )
  );
}

async function verifyWorkerEvidence(options: {
  readonly runner: ProcessRunner;
  readonly projectDirectory: string;
  readonly workerName: string;
  readonly remoteTag: string | null;
  readonly evidence: WorkerEvidence;
}): Promise<void> {
  if (options.remoteTag === null) {
    throw deployError(
      "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      "PROVIDE_DEPLOY_RECOVERY",
    );
  }
  if (options.remoteTag !== options.evidence.workerTag) {
    throw deployError(
      "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      "PROVIDE_DEPLOY_RECOVERY",
    );
  }
  if (
    !(await hasActiveVersion(
      options.runner,
      options.projectDirectory,
      options.workerName,
      options.evidence.versionId,
    ))
  ) {
    throw deployError(
      "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
      "PROVIDE_DEPLOY_RECOVERY",
    );
  }
}

async function resolveWorkerState(options: {
  readonly state: DeploymentState;
  readonly remoteTag: string | null;
  readonly receiptText: string | null;
  readonly recovery: ServerDeployRecovery | undefined;
  readonly runner: ProcessRunner;
  readonly projectDirectory: string;
  readonly workerName: string;
  readonly expectedOrigin: string;
}): Promise<{
  readonly newWorker: boolean;
  readonly recovered?: DeployRecord;
  readonly baseline?: WorkerEvidence;
}> {
  if (options.state.step !== "deploy-pending") {
    if (options.remoteTag === null) {
      if (options.state.worker !== undefined) {
        throw deployError(
          "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
          "INSPECT_CLOUDFLARE_WORKER",
        );
      }
      return { newWorker: true };
    }
    if (options.state.worker === undefined) {
      throw deployError(
        "SERVER_DEPLOY_OWNERSHIP_UNVERIFIED",
        "PROVIDE_DEPLOY_RECOVERY",
      );
    }
    if (options.state.worker.tag !== options.remoteTag) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "INSPECT_CLOUDFLARE_WORKER",
      );
    }
    return { newWorker: false };
  }

  if (options.remoteTag === null) {
    if (options.state.worker !== undefined) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "INSPECT_CLOUDFLARE_WORKER",
      );
    }
    return { newWorker: true };
  }

  const receipt = options.receiptText === null
    ? null
    : tryParseDeployRecord(options.receiptText, options.workerName);
  if (receipt !== null) {
    const stale = (
      options.state.worker !== undefined &&
      (options.state.versionId === undefined ||
        receipt.versionId === options.state.versionId)
    );
    const hasExplicitRecovery =
      options.recovery?.workerTag !== undefined &&
      options.recovery.versionId !== undefined;
    if (stale && !hasExplicitRecovery) {
      throw deployError(
        "SERVER_DEPLOY_RECEIPT_STALE",
        "PROVIDE_DEPLOY_RECOVERY",
        EXIT_CODE.USAGE,
      );
    }
    if (!stale) {
      if (
        !receipt.targets.some((target) =>
          targetMatches(target, options.expectedOrigin),
        )
      ) {
        throw deployError(
          "SERVER_DEPLOY_TARGET_UNVERIFIED",
          "PROVIDE_DEPLOY_RECOVERY",
        );
      }
      await verifyWorkerEvidence({
        runner: options.runner,
        projectDirectory: options.projectDirectory,
        workerName: options.workerName,
        remoteTag: options.remoteTag,
        evidence: receipt,
      });
      return { newWorker: false, recovered: receipt };
    }
  }

  if (
    options.recovery?.workerTag !== undefined &&
    options.recovery.versionId !== undefined
  ) {
    const baseline = {
      workerTag: options.recovery.workerTag,
      versionId: options.recovery.versionId,
    };
    await verifyWorkerEvidence({
      runner: options.runner,
      projectDirectory: options.projectDirectory,
      workerName: options.workerName,
      remoteTag: options.remoteTag,
      evidence: baseline,
    });
    return { newWorker: false, baseline };
  }

  throw deployError(
    "SERVER_DEPLOY_RECOVERY_REQUIRED",
    "PROVIDE_DEPLOY_RECOVERY",
    EXIT_CODE.USAGE,
  );
}

function withUpdatedState(
  state: DeploymentState,
  update: Partial<DeploymentState>,
  now: string,
): DeploymentState {
  return {
    ...state,
    ...update,
    updatedAt: now,
  };
}

async function reconcileResources(
  stateRoot: string,
  state: DeploymentState,
  api: ReturnType<typeof createCloudflareApi>,
  remoteD1: CloudflareResource | null,
  remoteQueues: ReadonlyMap<string, CloudflareResource | null>,
  now: () => string,
  observe: (state: DeploymentState) => void,
): Promise<DeploymentState> {
  const plan = reconcileThenCreateNames(state, remoteD1, remoteQueues);
  let current = state;

  if (plan.createD1) {
    let created: CloudflareResource;
    try {
      created = await api.createD1(state.resources.d1.name);
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      if (error instanceof CloudflareApiError) {
        throw deployError("SERVER_DEPLOY_AMBIGUOUS", "INSPECT_CLOUDFLARE_RESOURCES");
      }
      throw error;
    }
    current = withUpdatedState(
      current,
      {
        resources: {
          ...current.resources,
          d1: {
            name: current.resources.d1.name,
            id: created.id,
          },
        },
      },
      now(),
    );
    await saveDeploymentState(stateRoot, current);
    observe(current);
  } else if (current.resources.d1.id === undefined && remoteD1 !== null) {
    current = withUpdatedState(
      current,
      {
        resources: {
          ...current.resources,
          d1: {
            name: current.resources.d1.name,
            id: remoteD1.id,
          },
        },
      },
      now(),
    );
  }

  for (const name of plan.createQueues) {
    let created: CloudflareResource;
    try {
      created = await api.createQueue(name);
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      if (error instanceof CloudflareApiError) {
        throw deployError("SERVER_DEPLOY_AMBIGUOUS", "INSPECT_CLOUDFLARE_RESOURCES");
      }
      throw error;
    }
    current = withUpdatedState(
      current,
      {
        resources: {
          ...current.resources,
          queues: current.resources.queues.map((queue) =>
            queue.name === name ? { name, id: created.id } : queue),
        },
      },
      now(),
    );
    await saveDeploymentState(stateRoot, current);
    observe(current);
  }

  if (
    current.resources.d1.id === undefined ||
    current.resources.queues.some((queue) => queue.id === undefined)
  ) {
    throw deployError(
      "SERVER_DEPLOY_STATE_RECOVERY_REQUIRED",
      "INSPECT_SERVER_STATE",
    );
  }
  current = withUpdatedState(current, { step: "resources-ready" }, now());
  await saveDeploymentState(stateRoot, current);
  observe(current);
  return current;
}

async function secretNames(
  runner: ProcessRunner,
  projectDirectory: string,
  workerName: string,
): Promise<Set<DeploymentSecretName>> {
  const result = await runner.run({
    tool: "wrangler",
    args: ["secret", "list", "--name", workerName, "--format", "json"],
    cwd: projectDirectory,
    environment: WRANGLER_ENVIRONMENT,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
  });
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw processFailure(
      result,
      "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
      "CHECK_DEPLOYMENT_SECRETS",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw deployError(
      "SERVER_DEPLOY_REMOTE_READ_FAILED",
      "CHECK_DEPLOYMENT_SECRETS",
    );
  }
  if (!Array.isArray(parsed)) {
    throw deployError(
      "SERVER_DEPLOY_REMOTE_READ_FAILED",
      "CHECK_DEPLOYMENT_SECRETS",
    );
  }
  const names = new Set<DeploymentSecretName>();
  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry["name"] === "string") {
      const name = entry["name"] as DeploymentSecretName;
      if (DEPLOYMENT_SECRET_NAMES.includes(name)) {
        names.add(name);
      }
    }
  }
  return names;
}

function canonicalWorkersDevOrigin(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

function expectedOrigin(
  loaded: LoadedServerConfig,
  project: WranglerProject,
  subdomain?: string,
): string {
  if (project.workersDev) {
    if (subdomain === undefined) {
      throw deployError(
        "SERVER_DEPLOY_WORKERS_DEV_SUBDOMAIN_REQUIRED",
        "REGISTER_WORKERS_DEV_SUBDOMAIN",
        EXIT_CODE.USAGE,
      );
    }
    const canonical = canonicalWorkersDevOrigin(project.workerName, subdomain);
    if (
      loaded.config.publicOrigin !== undefined &&
      loaded.config.publicOrigin !== canonical
    ) {
      throw deployError(
        "SERVER_DEPLOY_CONFIG_INVALID",
        "RESOLVE_WORKER_ROUTING_CONFLICT",
        EXIT_CODE.USAGE,
      );
    }
    return canonical;
  }
  if (loaded.config.publicOrigin === undefined) {
    throw deployError(
      "SERVER_DEPLOY_ORIGIN_REQUIRED",
      "CONFIGURE_VERIFIED_CUSTOM_ORIGIN",
      EXIT_CODE.USAGE,
    );
  }
  return loaded.config.publicOrigin;
}

function validateOwnedVars(
  loaded: LoadedServerConfig,
  project: WranglerProject,
  origin: string,
): void {
  const vars = project.raw["vars"] as Record<string, unknown>;
  const expected = {
    PUBLIC_ORIGIN: origin,
    SCOPE: loaded.config.scope,
    QUEUE_NAME: project.workQueueName,
    DLQ_NAME: project.deadQueueName,
  } as const;
  if (
    Object.entries(expected).some(
      ([name, value]) =>
        vars[name] !== undefined && vars[name] !== value,
    )
  ) {
    throw deployError(
      "SERVER_DEPLOY_CONFIG_INVALID",
      "REMOVE_CONFLICTING_OWNED_VARS",
      EXIT_CODE.USAGE,
    );
  }
}

function effectiveConfig(
  loaded: LoadedServerConfig,
  project: WranglerProject,
  state: DeploymentState,
  origin: string,
): Record<string, unknown> {
  const d1 = state.resources.d1.id;
  if (d1 === undefined) {
    throw deployError("SERVER_DEPLOY_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }
  const raw = structuredClone(project.raw);
  raw["account_id"] = state.accountId;
  raw["d1_databases"] = (raw["d1_databases"] as Record<string, unknown>[]).map(
    (entry) => ({
      ...entry,
      database_id: d1,
    }),
  );
  const vars = { ...(raw["vars"] as Record<string, unknown>) };
  raw["vars"] = {
    ...vars,
    QUEUE_NAME: project.workQueueName,
    DLQ_NAME: project.deadQueueName,
    PUBLIC_ORIGIN: origin,
    SCOPE: loaded.config.scope,
  };
  return raw;
}

async function writePrivateAtomicFile(
  file: string,
  bytes: Uint8Array,
): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    const existing = await fs.lstat(file).catch(() => undefined);
    if (
      existing !== undefined &&
      (existing.isSymbolicLink() || !existing.isFile())
    ) {
      throw new Error("unsafe target");
    }
    handle = await fs.open(
      temporary,
      FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    const directoryHandle = await fs.open(directory, FS.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw deployError(
      "SERVER_DEPLOY_CONFIG_WRITE_FAILED",
      "INSPECT_PROJECT_FILES",
    );
  }
}

async function createEmptyPrivateReceipt(file: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(
      file,
      FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const directory = await fs.open(path.dirname(file), FS.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    throw deployError(
      "SERVER_DEPLOY_RECEIPT_UNAVAILABLE",
      "INSPECT_SERVER_STATE",
    );
  }
}

async function readPrivateReceipt(file: string): Promise<Buffer> {
  let handle;
  try {
    handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_DEPLOY_OUTPUT_BYTES) {
      throw new Error("invalid machine output");
    }
    await handle.chmod(0o600);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DEPLOY_OUTPUT_BYTES) {
      throw new Error("machine output too large");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseDeployRecord(
  text: string,
  workerName: string,
): DeployRecord {
  const records = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  for (const value of records.toReversed()) {
    if (
      isRecord(value) &&
      value["type"] === "deploy" &&
      value["version"] === 1 &&
      value["worker_name"] === workerName &&
      (value["wrangler_environment"] === undefined ||
        value["wrangler_environment"] === null) &&
      typeof value["worker_tag"] === "string" &&
      RESOURCE_NAME.test(value["worker_tag"]) &&
      typeof value["version_id"] === "string" &&
      RESOURCE_NAME.test(value["version_id"]) &&
      Array.isArray(value["targets"]) &&
      value["targets"].every((target) => typeof target === "string")
    ) {
      return {
        workerTag: value["worker_tag"],
        versionId: value["version_id"],
        targets: value["targets"] as string[],
      };
    }
  }
  throw deployError("SERVER_DEPLOY_TARGET_UNVERIFIED", "INSPECT_WRANGLER_OUTPUT");
}

function tryParseDeployRecord(
  text: string,
  workerName: string,
): DeployRecord | null {
  try {
    return parseDeployRecord(text, workerName);
  } catch (error) {
    if (error instanceof CliError) {
      return null;
    }
    throw error;
  }
}

function targetMatches(target: string, origin: string): boolean {
  if (target === origin) {
    return true;
  }
  const candidate = target.endsWith("/*") ? target.slice(0, -1) : target;
  try {
    const parsed = new URL(
      candidate.startsWith("https://") ? candidate : `https://${candidate}`,
    );
    return parsed.origin === origin && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function withDeploymentStateDetails(
  error: unknown,
  state: DeploymentState | null,
): unknown {
  if (!(error instanceof CliError) || state === null) {
    return error;
  }
  return new CliError(error.message, {
    code: error.code,
    exitCode: error.exitCode,
    details: {
      ...(error.details ?? {}),
      subcommand: "deploy",
      failedStep: state.step,
      operationId: state.operationId,
      confirmedResources: {
        d1: state.resources.d1,
        queues: state.resources.queues,
        worker: state.worker ?? null,
      },
    },
  });
}

async function deployWithWrangler(options: {
  readonly runner: ProcessRunner;
  readonly projectDirectory: string;
  readonly effectiveFile: string;
  readonly secrets: Readonly<Partial<DeploymentCredentials>>;
  readonly workerName: string;
  readonly expectedOrigin: string;
  readonly receiptFile: string;
}): Promise<DeployRecord> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "syndroo-deploy-"));
  const secretsFile = path.join(temporary, "secrets.json");
  try {
    await fs.chmod(temporary, 0o700);
    await createEmptyPrivateReceipt(options.receiptFile);
    const handle = await fs.open(
      secretsFile,
      FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | FS.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(options.secrets)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const result = await options.runner.run({
      tool: "wrangler",
      args: [
        "deploy",
        "--strict",
        "--secrets-file",
        secretsFile,
        "--config",
        options.effectiveFile,
      ],
      cwd: options.projectDirectory,
      environment: {
        ...WRANGLER_ENVIRONMENT,
        [WRANGLER_OUTPUT_KEY]: options.receiptFile,
      },
      timeoutMs: 300_000,
      maxOutputBytes: 65_536,
    });
    let bytes: Buffer;
    try {
      bytes = await readPrivateReceipt(options.receiptFile);
    } catch {
      throw deployError(
        "SERVER_DEPLOY_AMBIGUOUS",
        "ENABLE_WRANGLER_MACHINE_OUTPUT",
      );
    }
    const record = tryParseDeployRecord(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      options.workerName,
    );
    if (result.status === "spawn_error") {
      throw processFailure(result, "SERVER_DEPLOY_FAILED", "RETRY_DEPLOY");
    }
    if (result.status !== "exited" || result.exitCode !== 0) {
      throw deployError(
        "SERVER_DEPLOY_AMBIGUOUS",
        "RERUN_DEPLOY_TO_RECONCILE",
        EXIT_CODE.FAILURE,
        {
          receiptRetained: true,
          machineRecord: record === null
            ? null
            : {
                workerTag: record.workerTag,
                versionId: record.versionId,
              },
        },
      );
    }
    if (record === null) {
      throw deployError(
        "SERVER_DEPLOY_AMBIGUOUS",
        "RERUN_DEPLOY_TO_RECONCILE",
        EXIT_CODE.FAILURE,
        { receiptRetained: true },
      );
    }
    if (!record.targets.some((target) => targetMatches(target, options.expectedOrigin))) {
      throw deployError(
        "SERVER_DEPLOY_TARGET_UNVERIFIED",
        "VERIFY_PUBLIC_ORIGIN",
      );
    }
    return record;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function executeDeploy(
  dependencies: ServerDeployDependencies,
  options: ServerDeployOptions,
): Promise<ServerDeployResult> {
  if (!options.authorized) {
    throw deployError(
      "SERVER_DEPLOY_AUTHORIZATION_REQUIRED",
      "CONFIRM_DEPLOY",
      EXIT_CODE.USAGE,
    );
  }
  assertCloudflareApiEnvironment(dependencies.env);

  const projectDirectory = resolveServerProject(
    dependencies.cwd,
    options.projectDirectory,
  );
  const loaded = await loadServerConfig(projectDirectory);
  const project = await readWranglerProject(projectDirectory);
  const recovery = validateRecovery(options.recover, project);
  await validatePinnedWrangler(projectDirectory);
  await verifyWranglerVersion(dependencies.runner, projectDirectory);

  const stateRoot = resolveDeploymentStateRoot(
    dependencies.env,
    dependencies.stateRoot,
  );
  if (isInside(projectDirectory, stateRoot)) {
    throw deployError(
      "SERVER_STATE_UNAVAILABLE",
      "CHOOSE_STATE_ROOT_OUTSIDE_PROJECT",
      EXIT_CODE.USAGE,
    );
  }
  try {
    await ensureStateRoot(stateRoot);
  } catch {
    throw deployError(
      "SERVER_STATE_RECOVERY_REQUIRED",
      "INSPECT_SERVER_STATE",
    );
  }

  let observedState: DeploymentState | null = null;
  try {
    return await withDeploymentStateLock(stateRoot, async () => {
    const now = (): string => new Date().toISOString();
    let state = await loadDeploymentState(stateRoot, loaded.config.projectId);
    observedState = state;
    const requestedAccount = selectedAccount(
      dependencies,
      options,
      project,
      state,
    );
    const session = await resolveCloudflareSession(
      dependencies.runner,
      projectDirectory,
      dependencies.env,
      requestedAccount,
    );
    const configuredAccounts = [
      project.raw["account_id"],
      dependencies.env["CLOUDFLARE_ACCOUNT_ID"],
    ].filter((value): value is string => typeof value === "string" && value !== "");
    if (
      configuredAccounts.some((accountId) => accountId !== session.accountId)
    ) {
      throw deployError(
        "SERVER_DEPLOY_ACCOUNT_CONFLICT",
        "USE_ONE_CLOUDFLARE_ACCOUNT",
        EXIT_CODE.USAGE,
      );
    }
    if (state !== null && state.accountId !== session.accountId) {
      throw deployError(
        "SERVER_DEPLOY_RESOURCE_IDENTITY_MISMATCH",
        "INSPECT_SERVER_STATE",
      );
    }
    const api = createCloudflareApi({
      accountId: session.accountId,
      token: session.token,
      fetch: dependencies.fetch ?? globalThis.fetch,
    });
    const subdomain = project.workersDev
      ? await api.workersDevSubdomain()
      : undefined;
    const origin = expectedOrigin(loaded, project, subdomain);
    validateOwnedVars(loaded, project, origin);

    const remoteWorker = await api.worker(project.workerName);
    const remoteD1 = await api.listD1(project.d1Name);
    const remoteQueues = new Map<string, CloudflareResource | null>();
    for (const name of project.queueNames) {
      remoteQueues.set(name, await api.listQueue(name));
    }

    if (state === null) {
      state = newState(
        loaded,
        project,
        session.accountId,
        now(),
        randomBytes(16).toString("hex"),
      );
    }
    assertStateIdentity(state, loaded, project, session.accountId);
    state = await applyResourceRecovery(
      state,
      recovery,
      api,
      remoteD1,
      remoteQueues,
      now,
    );

    const pendingWithoutWorker = state.step === "deploy-pending" &&
      remoteWorker === null &&
      state.worker === undefined;
    if (pendingWithoutWorker) {
      state = withUpdatedState(
        state,
        {
          step: "resources-ready",
          operationId: randomBytes(16).toString("hex"),
        },
        now(),
      );
    }
    const receiptText = state.step === "deploy-pending"
      ? await loadDeploymentReceipt(stateRoot, state.operationId)
      : null;
    const workerResolution = await resolveWorkerState({
      state,
      remoteTag: remoteWorker?.tag ?? null,
      receiptText,
      recovery,
      runner: dependencies.runner,
      projectDirectory,
      workerName: project.workerName,
      expectedOrigin: origin,
    });
    await saveDeploymentState(stateRoot, state);
    observedState = state;

    if (workerResolution.baseline !== undefined) {
      state = withUpdatedState(
        state,
        {
          step: "resources-ready",
          worker: {
            name: project.workerName,
            tag: workerResolution.baseline.workerTag,
          },
          versionId: workerResolution.baseline.versionId,
        },
        now(),
      );
      await saveDeploymentState(stateRoot, state);
      observedState = state;
    }

    const credentials = await ensureDeploymentCredentials({
      stateRoot,
      projectId: loaded.config.projectId,
      accountId: session.accountId,
      workerName: project.workerName,
      newDeployment: workerResolution.newWorker,
      ...(options.credentials === undefined ? {} : { supplied: options.credentials }),
      ...(options.readCredential === undefined
        ? {}
        : { readCredential: options.readCredential }),
      ...(dependencies.randomBytes === undefined
        ? {}
        : { randomBytes: dependencies.randomBytes }),
    });

    if (workerResolution.recovered !== undefined) {
      if (
        state.resources.d1.id === undefined ||
        state.resources.queues.some((queue) => queue.id === undefined)
      ) {
        throw deployError(
          "SERVER_DEPLOY_STATE_RECOVERY_REQUIRED",
          "PROVIDE_RESOURCE_RECOVERY",
        );
      }
      const d1Id = state.resources.d1.id;
      state = withUpdatedState(
        state,
        {
          step: "deployed",
          worker: {
            name: project.workerName,
            tag: workerResolution.recovered.workerTag,
          },
          origin,
          versionId: workerResolution.recovered.versionId,
        },
        now(),
      );
      await saveDeploymentState(stateRoot, state);
      observedState = state;
      await updateServerConfig(projectDirectory, { publicOrigin: origin });
      return {
        subcommand: "deploy",
        status: "deployed",
        projectDirectory,
        accountId: session.accountId,
        workerName: project.workerName,
        origin,
        versionId: workerResolution.recovered.versionId,
        workerTag: workerResolution.recovered.workerTag,
        resources: {
          d1: {
            name: state.resources.d1.name,
            id: d1Id,
          },
          queues: state.resources.queues.map((queue) => ({
            name: queue.name,
            id: queue.id as string,
          })),
        },
      };
    }

    state = await reconcileResources(
      stateRoot,
      state,
      api,
      remoteD1,
      remoteQueues,
      now,
      (next) => {
        observedState = next;
      },
    );

    const existingSecretNames = workerResolution.newWorker
      ? new Set<DeploymentSecretName>()
      : await secretNames(dependencies.runner, projectDirectory, project.workerName);
    const secretsToUpload: Partial<DeploymentCredentials> = {};
    for (const name of DEPLOYMENT_SECRET_NAMES) {
      if (!existingSecretNames.has(name)) {
        secretsToUpload[name] = credentials[name];
      }
    }

    const config = effectiveConfig(loaded, project, state, origin);
    const effectiveFile = path.join(projectDirectory, "wrangler.effective.jsonc");
    await writePrivateAtomicFile(
      effectiveFile,
      Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
    );

    state = withUpdatedState(
      state,
      {
        step: "deploy-pending",
        operationId: randomBytes(16).toString("hex"),
        ...(state.worker === undefined ? {} : { worker: state.worker }),
      },
      now(),
    );
    await saveDeploymentState(stateRoot, state);
    observedState = state;

    const deployed = await deployWithWrangler({
      runner: dependencies.runner,
      projectDirectory,
      effectiveFile,
      secrets: secretsToUpload,
      workerName: project.workerName,
      expectedOrigin: origin,
      receiptFile: path.join(
        stateRoot,
        deploymentReceiptFileName(state.operationId),
      ),
    });
    state = withUpdatedState(
      state,
      {
        step: "deployed",
        worker: { name: project.workerName, tag: deployed.workerTag },
        origin,
        versionId: deployed.versionId,
      },
      now(),
    );
    await saveDeploymentState(stateRoot, state);
    observedState = state;
    await updateServerConfig(projectDirectory, { publicOrigin: origin });

    return {
      subcommand: "deploy",
      status: "deployed",
      projectDirectory,
      accountId: session.accountId,
      workerName: project.workerName,
      origin,
      versionId: deployed.versionId,
      workerTag: deployed.workerTag,
      resources: {
        d1: {
          name: state.resources.d1.name,
          id: state.resources.d1.id as string,
        },
        queues: state.resources.queues.map((queue) => ({
          name: queue.name,
          id: queue.id as string,
        })),
      },
    };
    });
  } catch (error) {
    throw withDeploymentStateDetails(error, observedState);
  }
}

export async function runServerDeploy(
  dependencies: ServerDeployDependencies,
  options: ServerDeployOptions,
): Promise<ServerDeployResult> {
  try {
    return await executeDeploy(dependencies, options);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw deployError("SERVER_DEPLOY_FAILED", "INSPECT_DEPLOYMENT");
  }
}
