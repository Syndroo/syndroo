import { randomBytes } from "node:crypto";
import path from "node:path";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import {
  acquireWriteLock,
  releaseWriteLock,
  withProcessQueue,
} from "../runtime/filesystem/lock.js";
import {
  createPrivateStateFile,
  defaultServerStateRoot,
  readPrivateStateFile,
  writePrivateStateFile,
} from "./state.js";

export const DEPLOYMENT_SECRET_NAMES = [
  "API_BEARER",
  "SECRET_KEY",
  "RUNTIME_KEY",
] as const;

export type DeploymentSecretName = (typeof DEPLOYMENT_SECRET_NAMES)[number];
export type DeploymentCredentials = Record<DeploymentSecretName, string>;

export type DeploymentResourceIdentity = {
  readonly name: string;
  readonly id: string;
};

export type DeploymentResourceRecord = {
  readonly name: string;
  readonly id?: string;
};

export type DeploymentState = {
  readonly version: 1;
  readonly projectId: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly step: "planned" | "resources-ready" | "deploy-pending" | "deployed";
  readonly operationId: string;
  readonly resources: {
    readonly d1: DeploymentResourceRecord;
    readonly queues: readonly DeploymentResourceRecord[];
  };
  readonly worker?: {
    readonly name: string;
    readonly tag: string;
  };
  readonly origin?: string;
  readonly versionId?: string;
  readonly updatedAt: string;
};

type DeploymentCredentialRecord = {
  readonly version: 1;
  readonly projectId: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly credentials: DeploymentCredentials;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ORIGIN = /^https:\/\/[^\s/]+$/;
const API_BEARER = /^[A-Za-z0-9._~+/-]{32,1024}$/;
const KEY = /^[0-9a-fA-F]{64}$/;
const MAX_SECRET_LENGTH = 8_192;
const MAX_RECEIPT_LENGTH = 1_048_576;

function deploymentError(
  code: string,
  nextAction?: string,
): CliError {
  return new CliError(code, {
    code,
    exitCode: nextAction === undefined ? EXIT_CODE.FAILURE : EXIT_CODE.USAGE,
    details: nextAction === undefined ? {} : { nextAction },
  });
}

function checkedProjectId(projectId: string): string {
  if (!UUID.test(projectId)) {
    throw deploymentError("SERVER_DEPLOY_CONFIG_INVALID");
  }
  return projectId;
}

export function deploymentStateFileName(projectId: string): string {
  return `deployment-${checkedProjectId(projectId)}.json`;
}

export function deploymentCredentialFileName(projectId: string): string {
  return `deployment-${checkedProjectId(projectId)}.credentials.json`;
}

export function deploymentReceiptFileName(operationId: string): string {
  if (!ID.test(operationId)) {
    throw deploymentError("SERVER_DEPLOY_CONFIG_INVALID");
  }
  return `deployment-${operationId}.receipt.jsonl`;
}

export function resolveDeploymentStateRoot(
  env: NodeJS.ProcessEnv,
  explicit?: string,
): string {
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) {
      throw deploymentError("SERVER_STATE_UNAVAILABLE");
    }
    return path.resolve(explicit);
  }

  try {
    return defaultServerStateRoot(env);
  } catch {
    throw deploymentError("SERVER_STATE_UNAVAILABLE");
  }
}

function decodeJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw deploymentError(code, "INSPECT_SERVER_STATE");
  }
}

async function readPrivateJson(
  stateRoot: string,
  name: string,
  code: string,
): Promise<unknown | null> {
  try {
    const bytes = await readPrivateStateFile(stateRoot, name);
    return bytes === null ? null : decodeJson(bytes, code);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw deploymentError(code, "INSPECT_SERVER_STATE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResource(value: unknown): value is DeploymentResourceIdentity {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    NAME.test(value["name"]) &&
    typeof value["id"] === "string" &&
    ID.test(value["id"])
  );
}

function validateDeploymentState(
  value: unknown,
  projectId: string,
): DeploymentState {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["projectId"] !== projectId ||
    typeof value["accountId"] !== "string" ||
    !ID.test(value["accountId"]) ||
    typeof value["workerName"] !== "string" ||
    !NAME.test(value["workerName"]) ||
    !["planned", "resources-ready", "deploy-pending", "deployed"].includes(
      typeof value["step"] === "string" ? value["step"] : "",
    ) ||
    typeof value["operationId"] !== "string" ||
    !ID.test(value["operationId"]) ||
    typeof value["updatedAt"] !== "string" ||
    !isRecord(value["resources"]) ||
    !isRecord(value["resources"]["d1"]) ||
    typeof value["resources"]["d1"]["name"] !== "string" ||
    !NAME.test(value["resources"]["d1"]["name"]) ||
    !Array.isArray(value["resources"]["queues"])
  ) {
    throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }

  const d1 = value["resources"]["d1"];
  const d1Id = d1["id"];
  if (d1Id !== undefined && (typeof d1Id !== "string" || !ID.test(d1Id))) {
    throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }

  const queues: DeploymentResourceRecord[] = [];
  for (const queue of value["resources"]["queues"]) {
    if (
      !isRecord(queue) ||
      typeof queue["name"] !== "string" ||
      !NAME.test(queue["name"]) ||
      (queue["id"] !== undefined &&
        (typeof queue["id"] !== "string" || !ID.test(queue["id"])))
    ) {
      throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
    }
    queues.push({
      name: queue["name"],
      ...(typeof queue["id"] === "string" ? { id: queue["id"] } : {}),
    });
  }

  let worker: DeploymentState["worker"];
  if (value["worker"] !== undefined) {
    if (
      !isRecord(value["worker"]) ||
      value["worker"]["name"] !== value["workerName"] ||
      typeof value["worker"]["tag"] !== "string" ||
      !ID.test(value["worker"]["tag"])
    ) {
      throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
    }
    worker = {
      name: value["workerName"],
      tag: value["worker"]["tag"],
    };
  }

  if (
    value["origin"] !== undefined &&
    (typeof value["origin"] !== "string" || !ORIGIN.test(value["origin"]))
  ) {
    throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }
  if (
    value["versionId"] !== undefined &&
    (typeof value["versionId"] !== "string" || !ID.test(value["versionId"]))
  ) {
    throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }

  return {
    version: 1,
    projectId,
    accountId: value["accountId"],
    workerName: value["workerName"],
    step: value["step"] as DeploymentState["step"],
    operationId: value["operationId"],
    resources: {
      d1: {
        name: d1["name"] as string,
        ...(typeof d1Id === "string" ? { id: d1Id } : {}),
      },
      queues,
    },
    ...(worker === undefined ? {} : { worker }),
    ...(typeof value["origin"] === "string" ? { origin: value["origin"] } : {}),
    ...(typeof value["versionId"] === "string"
      ? { versionId: value["versionId"] }
      : {}),
    updatedAt: value["updatedAt"],
  };
}

export async function loadDeploymentState(
  stateRoot: string,
  projectId: string,
): Promise<DeploymentState | null> {
  const value = await readPrivateJson(
    stateRoot,
    deploymentStateFileName(projectId),
    "SERVER_STATE_RECOVERY_REQUIRED",
  );
  return value === null ? null : validateDeploymentState(value, projectId);
}

export async function saveDeploymentState(
  stateRoot: string,
  state: DeploymentState,
): Promise<void> {
  const validated = validateDeploymentState(state, state.projectId);
  try {
    await writePrivateStateFile(
      stateRoot,
      deploymentStateFileName(validated.projectId),
      Buffer.from(`${JSON.stringify(validated, null, 2)}\n`),
    );
  } catch {
    throw deploymentError("SERVER_DEPLOY_STATE_WRITE_FAILED", "INSPECT_SERVER_STATE");
  }
}

function validSecret(
  name: DeploymentSecretName,
  value: unknown,
): value is string {
  return typeof value === "string" &&
    value.length <= MAX_SECRET_LENGTH &&
    !value.includes("\u0000") &&
    (name === "API_BEARER" ? API_BEARER.test(value) : KEY.test(value));
}

export function validateDeploymentCredentials(
  value: unknown,
): DeploymentCredentials {
  if (!isRecord(value)) {
    throw deploymentError(
      "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
      "IMPORT_DEPLOY_CREDENTIALS",
    );
  }
  for (const name of DEPLOYMENT_SECRET_NAMES) {
    if (!validSecret(name, value[name])) {
      throw deploymentError(
        "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
        "IMPORT_DEPLOY_CREDENTIALS",
      );
    }
  }
  return {
    API_BEARER: value["API_BEARER"] as string,
    SECRET_KEY: value["SECRET_KEY"] as string,
    RUNTIME_KEY: value["RUNTIME_KEY"] as string,
  };
}

function validateCredentials(
  value: unknown,
  projectId: string,
  accountId?: string,
  workerName?: string,
): DeploymentCredentials {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["projectId"] !== projectId ||
    typeof value["accountId"] !== "string" ||
    !ID.test(value["accountId"]) ||
    typeof value["workerName"] !== "string" ||
    !NAME.test(value["workerName"]) ||
    (accountId !== undefined && value["accountId"] !== accountId) ||
    (workerName !== undefined && value["workerName"] !== workerName) ||
    !isRecord(value["credentials"])
  ) {
    throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "IMPORT_DEPLOY_CREDENTIALS");
  }

  const credentials = value["credentials"];
  try {
    return validateDeploymentCredentials(credentials);
  } catch {
    throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "IMPORT_DEPLOY_CREDENTIALS");
  }
}

export async function loadDeploymentCredentials(
  stateRoot: string,
  projectId: string,
  identity?: {
    readonly accountId: string;
    readonly workerName: string;
  },
): Promise<DeploymentCredentials | null> {
  const value = await readPrivateJson(
    stateRoot,
    deploymentCredentialFileName(projectId),
    "SERVER_STATE_RECOVERY_REQUIRED",
  );
  return value === null
    ? null
    : validateCredentials(
        value,
        projectId,
        identity?.accountId,
        identity?.workerName,
      );
}

export async function loadDeploymentReceipt(
  stateRoot: string,
  operationId: string,
): Promise<string | null> {
  let bytes: Buffer | null;
  try {
    bytes = await readPrivateStateFile(
      stateRoot,
      deploymentReceiptFileName(operationId),
    );
  } catch {
    throw deploymentError(
      "SERVER_DEPLOY_RECEIPT_UNAVAILABLE",
      "RERUN_DEPLOY_TO_RECONCILE",
    );
  }
  if (bytes === null) {
    return null;
  }
  if (bytes.length > MAX_RECEIPT_LENGTH) {
    throw deploymentError(
      "SERVER_DEPLOY_RECEIPT_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw deploymentError(
      "SERVER_DEPLOY_RECEIPT_INVALID",
      "PROVIDE_DEPLOY_RECOVERY",
    );
  }
}

export type EnsureDeploymentCredentialsOptions = {
  readonly stateRoot: string;
  readonly projectId: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly newDeployment: boolean;
  readonly supplied?: Partial<DeploymentCredentials>;
  readonly readCredential?: (
    name: DeploymentSecretName,
  ) => Promise<string | undefined>;
  readonly randomBytes?: (size: number) => Uint8Array;
};

export async function ensureDeploymentCredentials(
  options: EnsureDeploymentCredentialsOptions,
): Promise<DeploymentCredentials> {
  const existing = await loadDeploymentCredentials(
    options.stateRoot,
    options.projectId,
    {
      accountId: options.accountId,
      workerName: options.workerName,
    },
  );
  if (existing !== null) {
    for (const name of DEPLOYMENT_SECRET_NAMES) {
      const supplied = options.supplied?.[name];
      if (supplied !== undefined && supplied !== existing[name]) {
        throw deploymentError(
          "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
          "USE_EXISTING_DEPLOY_CREDENTIALS",
        );
      }
    }
    return existing;
  }

  const credentials = {} as DeploymentCredentials;
  for (const name of DEPLOYMENT_SECRET_NAMES) {
    const supplied = options.supplied?.[name];
    let value = supplied;
    if (value === undefined && options.readCredential !== undefined) {
      try {
        value = await options.readCredential(name);
      } catch {
        throw deploymentError(
          "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
          "IMPORT_DEPLOY_CREDENTIALS",
        );
      }
    }
    if (value === undefined && options.newDeployment) {
      const bytes = (options.randomBytes ?? randomBytes)(32);
      if (bytes.byteLength !== 32) {
        throw deploymentError(
          "SERVER_DEPLOY_CREDENTIAL_WRITE_FAILED",
          "CHECK_SECURE_RANDOMNESS",
        );
      }
      value = Buffer.from(bytes).toString("hex");
    }
    if (!validSecret(name, value)) {
      throw deploymentError(
        "SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED",
        "IMPORT_DEPLOY_CREDENTIALS",
      );
    }
    credentials[name] = value;
  }

  const record: DeploymentCredentialRecord = {
    version: 1,
    projectId: options.projectId,
    accountId: options.accountId,
    workerName: options.workerName,
    credentials,
  };
  try {
    await createPrivateStateFile(
      options.stateRoot,
      deploymentCredentialFileName(options.projectId),
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
    );
  } catch {
    throw deploymentError("SERVER_DEPLOY_CREDENTIAL_WRITE_FAILED", "INSPECT_SERVER_STATE");
  }
  return credentials;
}

export async function withDeploymentStateLock<T>(
  stateRoot: string,
  work: () => Promise<T>,
  now: () => string = () => new Date().toISOString(),
): Promise<T> {
  const resolved = path.resolve(stateRoot);
  return await withProcessQueue(resolved, async () => {
    let held;
    try {
      held = await acquireWriteLock(resolved, now());
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "STATE_BUSY") {
        throw deploymentError("SERVER_DEPLOY_STATE_BUSY", "WAIT_FOR_DEPLOY_TO_FINISH");
      }
      throw deploymentError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
    }

    try {
      return await work();
    } finally {
      await releaseWriteLock(resolved, held);
    }
  });
}
