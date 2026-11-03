import { randomUUID as systemRandomUUID } from "node:crypto";
import path from "node:path";

import { Syndroo, type FetchLike } from "@syndroo/sdk";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import {
  claimThreadsConnectDraftLocked,
  clearThreadsConnectDraftIfMatchesLocked,
  loadThreadsConnectDraftLocked,
} from "./ci-state.js";
import { loadServerConfig, updateServerConfig, type LoadedServerConfig } from "./config.js";
import {
  loadDeploymentCredentials,
  loadDeploymentState,
  withDeploymentStateLock,
  type DeploymentState,
} from "./deployment-state.js";
import { readProjectFile, MAX_PROJECT_FILE_BYTES } from "./foundation.js";
import {
  ThreadsCiError,
  assertRequestId,
  parseCanonicalHttpsOrigin,
  parseThreadsPostBytes,
  runThreadsBootstrap,
  runThreadsPublish,
  type BootstrapResult,
  type PublishRunResult,
  type ThreadsCiSdk,
} from "./threads-flow.js";

const MAX_SECRET_BYTES = 8_192;

export type ThreadsClientFactory = (
  origin: string,
  token: string,
) => ThreadsCiSdk;

export type ThreadsCommandDependencies = {
  readonly io: CliIo;
  readonly projectDirectory: string;
  readonly stateRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly json: boolean;
  readonly sleepMs: number;
  readonly waitTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly clientFactory?: ThreadsClientFactory;
  readonly fetch?: FetchLike;
  readonly randomUUID?: () => string;
  readonly now?: () => number;
};

export type ServerThreadsConnectOptions = {
  readonly appId?: string;
  readonly requestId?: string;
  readonly appSecretStdin: boolean;
  readonly restart: boolean;
};

export type ServerThreadsPublishOptions = {
  readonly input?: string;
  readonly requestId?: string;
  readonly yes: boolean;
};

export type ServerThreadsConnectResult = BootstrapResult & {
  readonly subcommand: "connect";
  readonly requestId: string;
};

export type ServerThreadsPublishResult = PublishRunResult & {
  readonly subcommand: "publish";
};

type ConnectBinding = {
  readonly projectId: string;
  readonly origin: string;
  readonly appId: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly workerTag: string;
  readonly versionId: string;
};

function commandError(
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

function defaultClientFactory(
  fetch: FetchLike | undefined,
): ThreadsClientFactory {
  return (origin, token) =>
    new Syndroo({
      baseUrl: origin,
      apiKey: token,
      ...(fetch === undefined ? {} : { fetch }),
    });
}

function safeAuthorizationText(value: string): string | undefined {
  if (value.length === 0 || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function deploymentBinding(
  projectId: string,
  origin: string,
  appId: string,
  state: DeploymentState,
): ConnectBinding {
  if (
    state.step !== "deployed" ||
    state.origin !== origin ||
    state.worker === undefined ||
    state.versionId === undefined
  ) {
    throw commandError(
      "SERVER_THREADS_DEPLOYMENT_MISMATCH",
      "RUN_SERVER_DOCTOR",
    );
  }
  return {
    projectId,
    origin,
    appId,
    accountId: state.accountId,
    workerName: state.workerName,
    workerTag: state.worker.tag,
    versionId: state.versionId,
  };
}

function bindingMatches(
  expected: ConnectBinding,
  loaded: LoadedServerConfig,
  state: DeploymentState | null,
): boolean {
  const configuredAppId = loaded.config.threads?.appId;
  return loaded.config.projectId === expected.projectId &&
    loaded.config.publicOrigin === expected.origin &&
    (configuredAppId === undefined || configuredAppId === expected.appId) &&
    state !== null &&
    state.step === "deployed" &&
    state.origin === expected.origin &&
    state.accountId === expected.accountId &&
    state.workerName === expected.workerName &&
    state.worker?.tag === expected.workerTag &&
    state.versionId === expected.versionId;
}

async function currentBindingMatches(
  dependencies: ThreadsCommandDependencies,
  expected: ConnectBinding,
): Promise<boolean> {
  try {
    const loaded = await loadServerConfig(dependencies.projectDirectory);
    const state = await loadDeploymentState(
      dependencies.stateRoot,
      expected.projectId,
    );
    return bindingMatches(expected, loaded, state);
  } catch {
    return false;
  }
}

function mapThreadsError(error: unknown, operationId?: string): CliError {
  if (error instanceof CliError) return error;
  if (!(error instanceof ThreadsCiError)) {
    return commandError(
      "SERVER_THREADS_FAILED",
      "INSPECT_THREADS_SETUP",
      EXIT_CODE.FAILURE,
      operationId === undefined ? {} : { operationId },
    );
  }
  const mapping: Record<ThreadsCiError["code"], { code: string; action: string }> = {
    INVALID_CONFIGURATION: {
      code: "SERVER_THREADS_CONFIG_INVALID",
      action: "CHECK_THREADS_CONFIGURATION",
    },
    INVALID_ARGUMENT: {
      code: "SERVER_THREADS_ARGUMENT_INVALID",
      action: "FIX_THREADS_ARGUMENTS",
    },
    INVALID_POST: {
      code: "SERVER_THREADS_POST_INVALID",
      action: "FIX_POST_DOCUMENT",
    },
    INVALID_RESPONSE: {
      code: "SERVER_THREADS_RESPONSE_INVALID",
      action: "INSPECT_THREADS_RESPONSE",
    },
    AUTHORIZATION_EXPIRED: {
      code: "SERVER_THREADS_AUTHORIZATION_EXPIRED",
      action: "RESTART_THREADS_CONNECT",
    },
    CALLBACK_TIMEOUT: {
      code: "SERVER_THREADS_CALLBACK_TIMEOUT",
      action: "RESUME_THREADS_CONNECT",
    },
    CREDENTIALS_REQUIRED_AGAIN: {
      code: "SERVER_THREADS_CREDENTIALS_REQUIRED",
      action: "RESTART_THREADS_CONNECT",
    },
  };
  const selected = mapping[error.code];
  return commandError(
    selected.code,
    selected.action,
    error.exitCode === 1 ? EXIT_CODE.FAILURE : EXIT_CODE.USAGE,
    operationId === undefined ? {} : { operationId },
  );
}

async function readSecretStdin(io: CliIo): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of io.stdin) {
    if (io.signal.aborted) {
      return undefined;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > MAX_SECRET_BYTES) {
      throw commandError("SERVER_THREADS_SECRET_INVALID", "PROVIDE_THREADS_APP_SECRET");
    }
    chunks.push(bytes);
    if (bytes.includes(10)) break;
  }
  const line = Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  return line.length === 0 ? undefined : line;
}

async function readAppSecret(
  dependencies: ThreadsCommandDependencies,
  appSecretStdin: boolean,
): Promise<string> {
  const environmentValue = dependencies.env["THREADS_APP_SECRET"];
  let value: string | undefined;
  if (appSecretStdin) {
    value = await readSecretStdin(dependencies.io);
    if (
      environmentValue !== undefined &&
      environmentValue !== "" &&
      environmentValue !== value
    ) {
      throw commandError(
        "SERVER_THREADS_SECRET_CONFLICT",
        "PROVIDE_ONE_THREADS_APP_SECRET",
      );
    }
  } else {
    value = environmentValue;
    if (
      (value === undefined || value === "") &&
      !dependencies.json &&
      dependencies.io.hasTty() &&
      dependencies.io.readHiddenTtyLine !== undefined
    ) {
      dependencies.io.writeTty?.("Threads App Secret: ");
      value = await dependencies.io.readHiddenTtyLine(
        600_000,
        dependencies.io.signal,
        () => dependencies.io.writeTty?.("Threads App Secret: "),
      );
      dependencies.io.writeTty?.("\n");
    }
  }
  if (
    value === undefined ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw commandError("SERVER_THREADS_SECRET_REQUIRED", "PROVIDE_THREADS_APP_SECRET");
  }
  return value;
}

async function deployedThreadsContext(
  projectDirectory: string,
  stateRoot: string,
): Promise<{
  readonly loaded: LoadedServerConfig;
  readonly origin: string;
  readonly appId: string;
  readonly adminToken: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly workerTag: string;
}> {
  const loaded = await loadServerConfig(projectDirectory);
  if (loaded.config.publicOrigin === undefined) {
    throw commandError("SERVER_THREADS_DEPLOYMENT_REQUIRED", "DEPLOY_SERVER_FIRST");
  }
  const origin = parseCanonicalHttpsOrigin(loaded.config.publicOrigin);
  const state = await loadDeploymentState(stateRoot, loaded.config.projectId);
  if (
    state === null ||
    state.step !== "deployed" ||
    state.origin !== origin ||
    state.worker === undefined ||
    state.versionId === undefined
  ) {
    throw commandError(
      "SERVER_THREADS_DEPLOYMENT_MISMATCH",
      "RUN_SERVER_DOCTOR",
    );
  }
  const credentials = await loadDeploymentCredentials(
    stateRoot,
    loaded.config.projectId,
    { accountId: state.accountId, workerName: state.workerName },
  );
  if (credentials === null) {
    throw commandError(
      "SERVER_THREADS_ADMIN_RECOVERY_REQUIRED",
      "RECOVER_DEPLOYMENT_CREDENTIALS",
    );
  }
  const appId = loaded.config.threads?.appId;
  if (appId === undefined) {
    throw commandError("SERVER_THREADS_APP_ID_REQUIRED", "PROVIDE_THREADS_APP_ID");
  }
  return {
    loaded,
    origin,
    appId,
    adminToken: credentials.API_BEARER,
    accountId: state.accountId,
    workerName: state.workerName,
    workerTag: state.worker.tag,
  };
}

export async function runServerThreadsConnect(
  dependencies: ThreadsCommandDependencies,
  options: ServerThreadsConnectOptions,
): Promise<ServerThreadsConnectResult> {
  const loaded = await loadServerConfig(dependencies.projectDirectory);
  if (loaded.config.publicOrigin === undefined) {
    throw commandError("SERVER_THREADS_DEPLOYMENT_REQUIRED", "DEPLOY_SERVER_FIRST");
  }
  const origin = parseCanonicalHttpsOrigin(loaded.config.publicOrigin);
  const state = await loadDeploymentState(dependencies.stateRoot, loaded.config.projectId);
  if (
    state === null ||
    state.step !== "deployed" ||
    state.origin !== origin ||
    state.worker === undefined ||
    state.versionId === undefined
  ) {
    throw commandError("SERVER_THREADS_DEPLOYMENT_MISMATCH", "RUN_SERVER_DOCTOR");
  }
  const credentials = await loadDeploymentCredentials(
    dependencies.stateRoot,
    loaded.config.projectId,
    { accountId: state.accountId, workerName: state.workerName },
  );
  if (credentials === null) {
    throw commandError(
      "SERVER_THREADS_ADMIN_RECOVERY_REQUIRED",
      "RECOVER_DEPLOYMENT_CREDENTIALS",
    );
  }

  const configuredAppId = loaded.config.threads?.appId;
  if (
    options.appId !== undefined &&
    configuredAppId !== undefined &&
    options.appId !== configuredAppId
  ) {
    throw commandError("SERVER_THREADS_APP_CONFLICT", "USE_CONFIGURED_THREADS_APP_ID");
  }
  const appId = options.appId ?? configuredAppId;
  if (appId === undefined || !/^[0-9]{1,64}$/.test(appId)) {
    throw commandError("SERVER_THREADS_APP_ID_REQUIRED", "PROVIDE_THREADS_APP_ID");
  }
  let requestedId: string | undefined;
  if (options.requestId !== undefined) {
    try {
      requestedId = assertRequestId(options.requestId);
    } catch (error) {
      throw mapThreadsError(error);
    }
  }
  const appSecret = await readAppSecret(dependencies, options.appSecretStdin);
  const binding = deploymentBinding(
    loaded.config.projectId,
    origin,
    appId,
    state,
  );
  const now = dependencies.now ?? Date.now;
  const claim = await withDeploymentStateLock(dependencies.stateRoot, async () => {
    const currentConfig = await loadServerConfig(dependencies.projectDirectory);
    const currentState = await loadDeploymentState(
      dependencies.stateRoot,
      binding.projectId,
    );
    if (!bindingMatches(binding, currentConfig, currentState)) {
      throw commandError(
        "SERVER_THREADS_BINDING_CHANGED",
        "RESTART_THREADS_CONNECT",
        EXIT_CODE.FAILURE,
      );
    }
    return await claimThreadsConnectDraftLocked(dependencies.stateRoot, {
      projectId: binding.projectId,
      origin: binding.origin,
      appId: binding.appId,
      ...(requestedId === undefined ? {} : { requestId: requestedId }),
      restart: options.restart,
      newRequestId: dependencies.randomUUID ?? systemRandomUUID,
      now: () => new Date(now()).toISOString(),
    });
  });
  const requestId = claim.draft.requestId;

  const client = (dependencies.clientFactory ?? defaultClientFactory(dependencies.fetch))(
    origin,
    credentials.API_BEARER,
  );
  try {
    const result = await runThreadsBootstrap({
      client,
      syndrooUrl: origin,
      appId,
      appSecret,
      requestId,
      timeoutMs: dependencies.sleepMs,
      intervalMs: dependencies.pollIntervalMs,
      now,
      onAuthorization: ({ url, expiresAt, callbackUrl }) => {
        const safeUrl = safeAuthorizationText(url);
        if (safeUrl !== undefined) {
          dependencies.io.stderr.write(
            `Open this Threads authorization URL in a browser:\n${safeUrl}\n`,
          );
        }
        dependencies.io.stderr.write(
          `The registered callback must be exactly ${callbackUrl}.\n` +
            `The authorization expires at ${expiresAt}.\n`,
        );
      },
    });
    await withDeploymentStateLock(dependencies.stateRoot, async () => {
      const currentConfig = await loadServerConfig(dependencies.projectDirectory);
      const currentState = await loadDeploymentState(
        dependencies.stateRoot,
        binding.projectId,
      );
      if (!bindingMatches(binding, currentConfig, currentState)) {
        throw commandError(
          "SERVER_THREADS_BINDING_CHANGED",
          "INSPECT_THREADS_CONNECT_STATE",
          EXIT_CODE.FAILURE,
        );
      }
      const currentDraft = await loadThreadsConnectDraftLocked(
        dependencies.stateRoot,
        binding.projectId,
      );
      if (
        currentDraft === null ||
        currentDraft.requestId !== requestId ||
        currentDraft.origin !== origin ||
        currentDraft.appId !== appId
      ) {
        throw commandError(
          "SERVER_THREADS_STALE_CONNECT",
          "INSPECT_THREADS_CONNECT_STATE",
          EXIT_CODE.FAILURE,
        );
      }
      await updateServerConfig(dependencies.projectDirectory, {
        threads: { appId, connectionId: result.connectionId },
      });
      const cleared = await clearThreadsConnectDraftIfMatchesLocked(
        dependencies.stateRoot,
        binding.projectId,
        requestId,
      );
      if (!cleared) {
        throw commandError(
          "SERVER_THREADS_STALE_CONNECT",
          "INSPECT_THREADS_CONNECT_STATE",
          EXIT_CODE.FAILURE,
        );
      }
    });
    return { subcommand: "connect", ...result, requestId };
  } catch (error) {
    if (
      error instanceof ThreadsCiError &&
      error.code === "AUTHORIZATION_EXPIRED"
    ) {
      await withDeploymentStateLock(dependencies.stateRoot, async () => {
        if (!await currentBindingMatches(dependencies, binding)) return;
        await clearThreadsConnectDraftIfMatchesLocked(
          dependencies.stateRoot,
          binding.projectId,
          requestId,
        );
      });
    }
    throw mapThreadsError(error);
  }
}

export async function runServerThreadsPublish(
  dependencies: ThreadsCommandDependencies,
  options: ServerThreadsPublishOptions,
): Promise<ServerThreadsPublishResult> {
  if (!options.yes) {
    throw commandError(
      "SERVER_THREADS_AUTHORIZATION_REQUIRED",
      "CONFIRM_THREADS_PUBLICATION",
    );
  }
  if (options.input === undefined) {
    throw commandError("SERVER_THREADS_INPUT_REQUIRED", "PROVIDE_POST_FILE");
  }
  if (options.requestId === undefined) {
    throw commandError("SERVER_THREADS_REQUEST_ID_REQUIRED", "PROVIDE_REQUEST_ID");
  }
  const requestId = assertRequestId(options.requestId);
  const loaded = await loadServerConfig(dependencies.projectDirectory);
  if (loaded.config.publicOrigin === undefined) {
    throw commandError("SERVER_THREADS_DEPLOYMENT_REQUIRED", "DEPLOY_SERVER_FIRST");
  }
  const connectionId = loaded.config.threads?.connectionId;
  if (connectionId === undefined) {
    throw commandError("SERVER_THREADS_CONNECTION_REQUIRED", "CONNECT_THREADS_FIRST");
  }
  const origin = parseCanonicalHttpsOrigin(loaded.config.publicOrigin);
  const workflowOrigin = dependencies.env["SYNDROO_URL"];
  if (workflowOrigin !== undefined && workflowOrigin !== origin) {
    throw commandError("SERVER_THREADS_TARGET_CONFLICT", "USE_CONFIGURED_THREADS_TARGET");
  }
  const workflowConnection = dependencies.env["SYNDROO_CONNECTION_ID"];
  if (workflowConnection !== undefined && workflowConnection !== connectionId) {
    throw commandError("SERVER_THREADS_TARGET_CONFLICT", "USE_CONFIGURED_THREADS_TARGET");
  }
  const token = dependencies.env["SYNDROO_TOKEN"];
  if (
    token === undefined ||
    token.length === 0 ||
    token.length > 8_192 ||
    /[\u0000\r\n]/.test(token)
  ) {
    throw commandError(
      "SERVER_THREADS_SCOPED_TOKEN_REQUIRED",
      "PROVIDE_SCOPED_SYNDROO_TOKEN",
    );
  }
  const inputFile = path.isAbsolute(options.input)
    ? options.input
    : path.resolve(dependencies.projectDirectory, options.input);
  const bytes = await readProjectFile(inputFile);
  if (bytes === null || bytes.length > MAX_PROJECT_FILE_BYTES) {
    throw commandError("SERVER_THREADS_INPUT_UNREADABLE", "FIX_POST_PATH");
  }
  let text: string;
  try {
    text = parseThreadsPostBytes(bytes);
  } catch (error) {
    throw mapThreadsError(error, requestId);
  }
  const client = (dependencies.clientFactory ?? defaultClientFactory(dependencies.fetch))(
    origin,
    token,
  );
  try {
    const result = await runThreadsPublish({
      client,
      connectionId,
      requestId,
      text,
      yes: true,
      waitTimeoutMs: dependencies.waitTimeoutMs,
      pollIntervalMs: dependencies.pollIntervalMs,
    });
    return { subcommand: "publish", ...result };
  } catch (error) {
    throw mapThreadsError(error, requestId);
  }
}
