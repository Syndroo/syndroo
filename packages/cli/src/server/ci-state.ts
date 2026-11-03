import { randomBytes as systemRandomBytes } from "node:crypto";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import { withDeploymentStateLock } from "./deployment-state.js";
import {
  readPrivateStateFile,
  writePrivateStateFile,
} from "./state.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORKER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONNECTION = /^conn_[A-Za-z0-9._:-]{1,123}$/;
const BEARER = /^[A-Za-z0-9._~+/-]{32,1024}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ORIGIN = /^https:\/\/[^\s/]+$/;

export type ServerCiState = {
  readonly version: 1;
  readonly projectId: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly workerTag: string;
  readonly connectionId: string;
  readonly bearer: string;
  readonly workerUploaded: boolean;
  readonly github?: {
    readonly repoId: string;
    readonly repository: string;
    readonly configured: boolean;
  };
  readonly updatedAt: string;
};

export type ThreadsConnectDraft = {
  readonly version: 1;
  readonly projectId: string;
  readonly origin: string;
  readonly appId: string;
  readonly requestId: string;
  readonly createdAt: string;
};

export type ThreadsConnectDraftClaim = {
  readonly draft: ThreadsConnectDraft;
  readonly reused: boolean;
};

function stateError(code: string, nextAction: string): CliError {
  return new CliError(code, {
    code,
    exitCode: EXIT_CODE.USAGE,
    details: { nextAction },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ciStateFileName(projectId: string): string {
  if (!UUID.test(projectId)) {
    throw stateError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }
  return `ci-${projectId}.json`;
}

function threadsDraftFileName(projectId: string): string {
  if (!UUID.test(projectId)) {
    throw stateError("SERVER_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }
  return `threads-connect-${projectId}.json`;
}

function decode(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw stateError(code, "INSPECT_SERVER_STATE");
  }
}

async function readJson(
  stateRoot: string,
  name: string,
  code: string,
): Promise<unknown | null> {
  try {
    const bytes = await readPrivateStateFile(stateRoot, name);
    return bytes === null ? null : decode(bytes, code);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw stateError(code, "INSPECT_SERVER_STATE");
  }
}

function validateCiState(value: unknown, projectId: string): ServerCiState {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["projectId"] !== projectId ||
    typeof value["accountId"] !== "string" || !ID.test(value["accountId"]) ||
    typeof value["workerName"] !== "string" || !WORKER.test(value["workerName"]) ||
    typeof value["workerTag"] !== "string" || !ID.test(value["workerTag"]) ||
    typeof value["connectionId"] !== "string" || !CONNECTION.test(value["connectionId"]) ||
    typeof value["bearer"] !== "string" || !BEARER.test(value["bearer"]) ||
    typeof value["workerUploaded"] !== "boolean" ||
    typeof value["updatedAt"] !== "string" || !Number.isFinite(Date.parse(value["updatedAt"]))
  ) {
    throw stateError("SERVER_CI_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
  }

  let github: ServerCiState["github"];
  if (value["github"] !== undefined) {
    const raw = value["github"];
    if (
      !isRecord(raw) ||
      typeof raw["repoId"] !== "string" || !ID.test(raw["repoId"]) ||
      typeof raw["repository"] !== "string" || raw["repository"].length > 201 ||
      typeof raw["configured"] !== "boolean"
    ) {
      throw stateError("SERVER_CI_STATE_RECOVERY_REQUIRED", "INSPECT_SERVER_STATE");
    }
    github = {
      repoId: raw["repoId"],
      repository: raw["repository"],
      configured: raw["configured"],
    };
  }

  return {
    version: 1,
    projectId,
    accountId: value["accountId"],
    workerName: value["workerName"],
    workerTag: value["workerTag"],
    connectionId: value["connectionId"],
    bearer: value["bearer"],
    workerUploaded: value["workerUploaded"],
    ...(github === undefined ? {} : { github }),
    updatedAt: value["updatedAt"],
  };
}

export async function loadCiState(
  stateRoot: string,
  projectId: string,
): Promise<ServerCiState | null> {
  const value = await readJson(
    stateRoot,
    ciStateFileName(projectId),
    "SERVER_CI_STATE_RECOVERY_REQUIRED",
  );
  return value === null ? null : validateCiState(value, projectId);
}

export async function saveCiState(
  stateRoot: string,
  state: ServerCiState,
): Promise<void> {
  await withDeploymentStateLock(stateRoot, async () => {
    await saveCiStateLocked(stateRoot, state);
  });
}

export async function saveCiStateLocked(
  stateRoot: string,
  state: ServerCiState,
): Promise<void> {
  const validated = validateCiState(state, state.projectId);
  try {
    await writePrivateStateFile(
      stateRoot,
      ciStateFileName(validated.projectId),
      Buffer.from(`${JSON.stringify(validated, null, 2)}\n`),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw stateError("SERVER_CI_STATE_WRITE_FAILED", "INSPECT_SERVER_STATE");
  }
}

export function generateCiBearer(
  randomBytes: (size: number) => Uint8Array = systemRandomBytes,
): string {
  const bytes = randomBytes(48);
  if (bytes.byteLength !== 48) {
    throw stateError("SERVER_CI_TOKEN_WRITE_FAILED", "CHECK_SECURE_RANDOMNESS");
  }
  const bearer = Buffer.from(bytes).toString("base64url");
  if (!BEARER.test(bearer)) {
    throw stateError("SERVER_CI_TOKEN_WRITE_FAILED", "CHECK_SECURE_RANDOMNESS");
  }
  return bearer;
}

function validateThreadsDraft(
  value: unknown,
  projectId: string,
): ThreadsConnectDraft {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["projectId"] !== projectId ||
    typeof value["origin"] !== "string" || !ORIGIN.test(value["origin"]) ||
    typeof value["appId"] !== "string" || !/^[0-9]{1,64}$/.test(value["appId"]) ||
    typeof value["requestId"] !== "string" || !REQUEST_ID.test(value["requestId"]) ||
    typeof value["createdAt"] !== "string" || !Number.isFinite(Date.parse(value["createdAt"]))
  ) {
    throw stateError("SERVER_THREADS_RESUME_CONFLICT", "INSPECT_SERVER_STATE");
  }
  return {
    version: 1,
    projectId,
    origin: value["origin"],
    appId: value["appId"],
    requestId: value["requestId"],
    createdAt: value["createdAt"],
  };
}

export async function loadThreadsConnectDraft(
  stateRoot: string,
  projectId: string,
): Promise<ThreadsConnectDraft | null> {
  return await loadThreadsConnectDraftLocked(stateRoot, projectId);
}

export async function loadThreadsConnectDraftLocked(
  stateRoot: string,
  projectId: string,
): Promise<ThreadsConnectDraft | null> {
  const value = await readJson(
    stateRoot,
    threadsDraftFileName(projectId),
    "SERVER_THREADS_RESUME_CONFLICT",
  );
  if (value === null) return null;
  if (isRecord(value) && value["deleted"] === true && Object.keys(value).length === 1) {
    return null;
  }
  return validateThreadsDraft(value, projectId);
}

async function writeThreadsConnectDraftLocked(
  stateRoot: string,
  draft: ThreadsConnectDraft,
): Promise<void> {
  const validated = validateThreadsDraft(draft, draft.projectId);
  try {
    await writePrivateStateFile(
      stateRoot,
      threadsDraftFileName(validated.projectId),
      Buffer.from(`${JSON.stringify(validated, null, 2)}\n`),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw stateError("SERVER_THREADS_RESUME_WRITE_FAILED", "INSPECT_SERVER_STATE");
  }
}

export async function saveThreadsConnectDraftLocked(
  stateRoot: string,
  draft: ThreadsConnectDraft,
): Promise<void> {
  await writeThreadsConnectDraftLocked(stateRoot, draft);
}

export async function saveThreadsConnectDraft(
  stateRoot: string,
  draft: ThreadsConnectDraft,
): Promise<void> {
  try {
    await withDeploymentStateLock(stateRoot, async () => {
      await saveThreadsConnectDraftLocked(stateRoot, draft);
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw stateError("SERVER_THREADS_RESUME_WRITE_FAILED", "INSPECT_SERVER_STATE");
  }
}

export async function claimThreadsConnectDraftLocked(
  stateRoot: string,
  options: {
    readonly projectId: string;
    readonly origin: string;
    readonly appId: string;
    readonly requestId?: string;
    readonly restart: boolean;
    readonly newRequestId: () => string;
    readonly now: () => string;
  },
): Promise<ThreadsConnectDraftClaim> {
  const pending = await loadThreadsConnectDraftLocked(
    stateRoot,
    options.projectId,
  );
  if (pending !== null) {
    const requestId = options.requestId ?? pending.requestId;
    const bindingMismatch =
      pending.origin !== options.origin || pending.appId !== options.appId;
    if (
      bindingMismatch &&
      !(options.restart && requestId !== pending.requestId)
    ) {
      throw stateError("SERVER_THREADS_RESUME_CONFLICT", "INSPECT_THREADS_CONNECT_STATE");
    }
    if (!options.restart && requestId !== pending.requestId) {
      throw stateError("SERVER_THREADS_RESUME_CONFLICT", "REUSE_PENDING_THREADS_REQUEST_ID");
    }
    if (requestId === pending.requestId) {
      return { draft: pending, reused: true };
    }
  }

  const draft: ThreadsConnectDraft = {
    version: 1,
    projectId: options.projectId,
    origin: options.origin,
    appId: options.appId,
    requestId: options.requestId ?? options.newRequestId(),
    createdAt: options.now(),
  };
  await writeThreadsConnectDraftLocked(stateRoot, draft);
  return { draft, reused: false };
}

export async function clearThreadsConnectDraft(
  stateRoot: string,
  projectId: string,
): Promise<void> {
  await withDeploymentStateLock(stateRoot, async () => {
    await clearThreadsConnectDraftLocked(stateRoot, projectId);
  });
}

export async function clearThreadsConnectDraftLocked(
  stateRoot: string,
  projectId: string,
): Promise<void> {
  // An empty valid JSON object is deliberately not accepted by the loader; the
  // fixed `deleted:true` tombstone keeps the atomic file API and rejects reuse.
  try {
    await writePrivateStateFile(
      stateRoot,
      threadsDraftFileName(projectId),
      Buffer.from('{"deleted":true}\n'),
    );
  } catch {
    throw stateError("SERVER_THREADS_RESUME_WRITE_FAILED", "INSPECT_SERVER_STATE");
  }
}

export async function clearThreadsConnectDraftIfMatchesLocked(
  stateRoot: string,
  projectId: string,
  requestId: string,
): Promise<boolean> {
  const current = await loadThreadsConnectDraftLocked(stateRoot, projectId);
  if (current === null) return true;
  if (current.requestId !== requestId) return false;
  await clearThreadsConnectDraftLocked(stateRoot, projectId);
  return true;
}
