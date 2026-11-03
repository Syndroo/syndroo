import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import { runServerDoctor, type ServerDoctorResult } from "./doctor.js";
import {
  resolveDeploymentStateRoot,
  validateDeploymentCredentials,
  type DeploymentCredentials,
} from "./deployment-state.js";
import {
  runServerDeploy,
  type ServerDeployDependencies,
  type ServerDeployOptions,
  type ServerDeployRecovery,
  type ServerDeployResult,
} from "./deploy.js";
import {
  runServerGithubCi,
  type ServerGithubCiResult,
} from "./github.js";
import { runServerInit, type ServerInitResult } from "./init.js";
import { createNodeProcessRunner, type ProcessRunner } from "./process.js";
import {
  runServerThreadsConnect,
  runServerThreadsPublish,
  type ServerThreadsConnectResult,
  type ServerThreadsPublishResult,
  type ThreadsClientFactory,
} from "./threads.js";
import {
  BOOTSTRAP_TIMEOUT_LIMITS,
  PUBLISH_WAIT_LIMITS,
} from "./threads-flow.js";

export type ServerResult =
  | ServerInitResult
  | ServerDoctorResult
  | ServerDeployResult
  | ServerThreadsConnectResult
  | ServerThreadsPublishResult
  | ServerGithubCiResult;

export type ServerOverrides = {
  readonly processRunner?: ProcessRunner;
  readonly randomUUID?: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly stateRoot?: string;
  readonly fetch?: typeof fetch;
  readonly threadsClientFactory?: ThreadsClientFactory;
  readonly runDeploy?: typeof runServerDeploy;
  readonly now?: (() => number) | (() => string);
};

export type ServerGlobals = {
  readonly json: boolean;
  readonly verbose: boolean;
  readonly configPath?: string;
};

export type ServerCommandState = { exit: number };

export type ServerContext = {
  readonly io: CliIo;
  readonly json: boolean;
  readonly runner: ProcessRunner;
  readonly randomUUID?: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly projectDirectory?: string;
  readonly stateRoot: string;
  report(result: ServerResult, human: readonly string[]): void;
};

const MAX_RECOVERY_BYTES = 65_536;
const MAX_CREDENTIAL_BYTES = 65_536;

function serverUsage(code: string, nextAction?: string): CliError {
  return new CliError(code, {
    code,
    exitCode: EXIT_CODE.USAGE,
    details: nextAction === undefined ? {} : { nextAction },
  });
}

function context(
  io: CliIo,
  globals: ServerGlobals,
  overrides: ServerOverrides,
  projectDirectory?: string,
): ServerContext {
  if (globals.configPath !== undefined) {
    throw serverUsage("SERVER_LOCAL_CONFIG_UNSUPPORTED", "USE_SERVER_PROJECT");
  }
  const stateRoot = resolveDeploymentStateRoot(io.env, overrides.stateRoot);
  return {
    io,
    json: globals.json,
    runner: overrides.processRunner ?? createNodeProcessRunner(io.env, io.signal),
    ...(overrides.randomUUID === undefined ? {} : { randomUUID: overrides.randomUUID }),
    ...(overrides.randomBytes === undefined ? {} : { randomBytes: overrides.randomBytes }),
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    stateRoot,
    report(result, human): void {
      if (globals.json) {
        io.stdout.write(
          `${JSON.stringify({
            protocolVersion: 1,
            operation: "server",
            ok: true,
            result,
            error: null,
          })}\n`,
        );
      } else if (human.length > 0) {
        io.stdout.write(`${human.join("\n")}\n`);
      }
    },
  };
}

function projectDirectory(ctx: ServerContext): string {
  if (ctx.projectDirectory === undefined) {
    throw serverUsage("SERVER_PROJECT_REQUIRED", "SELECT_SERVER_PROJECT");
  }
  return path.resolve(ctx.io.cwd, ctx.projectDirectory);
}

function integerOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw serverUsage("USAGE");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw serverUsage("USAGE");
  }
  return parsed;
}

async function readBoundedInput(
  io: CliIo,
  source: string,
  maximum: number,
): Promise<Uint8Array> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of io.stdin) {
      if (io.signal.aborted) break;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += bytes.length;
      if (total > maximum) {
        throw serverUsage("SERVER_INPUT_INVALID", "PROVIDE_BOUNDED_INPUT");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path.resolve(io.cwd, source), FS.O_RDONLY | FS.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) {
      throw serverUsage("SERVER_INPUT_INVALID", "PROVIDE_BOUNDED_INPUT");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw serverUsage("SERVER_INPUT_UNREADABLE", "FIX_INPUT_PATH");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseRecovery(bytes: Uint8Array): ServerDeployRecovery | undefined {
  if (bytes.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw serverUsage("SERVER_DEPLOY_RECOVERY_INVALID", "PROVIDE_DEPLOY_RECOVERY");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw serverUsage("SERVER_DEPLOY_RECOVERY_INVALID", "PROVIDE_DEPLOY_RECOVERY");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["d1Id", "queues", "workerTag", "versionId"].includes(key),
    )
  ) {
    throw serverUsage("SERVER_DEPLOY_RECOVERY_INVALID", "PROVIDE_DEPLOY_RECOVERY");
  }
  let queues: Record<string, string> | undefined;
  if (record["queues"] !== undefined) {
    if (typeof record["queues"] !== "object" || record["queues"] === null || Array.isArray(record["queues"])) {
      throw serverUsage("SERVER_DEPLOY_RECOVERY_INVALID", "PROVIDE_DEPLOY_RECOVERY");
    }
    queues = {};
    for (const [name, id] of Object.entries(record["queues"] as Record<string, unknown>)) {
      if (typeof id !== "string") {
        throw serverUsage("SERVER_DEPLOY_RECOVERY_INVALID", "PROVIDE_DEPLOY_RECOVERY");
      }
      queues[name] = id;
    }
  }
  return {
    ...(typeof record["d1Id"] === "string" ? { d1Id: record["d1Id"] } : {}),
    ...(queues === undefined ? {} : { queues }),
    ...(typeof record["workerTag"] === "string" ? { workerTag: record["workerTag"] } : {}),
    ...(typeof record["versionId"] === "string" ? { versionId: record["versionId"] } : {}),
  };
}

function parseCredentials(bytes: Uint8Array): Partial<DeploymentCredentials> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw serverUsage("SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED", "IMPORT_DEPLOY_CREDENTIALS");
  }
  try {
    return validateDeploymentCredentials(value);
  } catch {
    throw serverUsage("SERVER_DEPLOY_CREDENTIAL_RECOVERY_REQUIRED", "IMPORT_DEPLOY_CREDENTIALS");
  }
}

export function registerServerCommands(
  program: Command,
  io: CliIo,
  globals: ServerGlobals,
  state: ServerCommandState,
  overrides: ServerOverrides = {},
): void {
  const server = program
    .command("server")
    .description("Initialize and operate a user-owned Syndroo deployment project.")
    .option("--project <directory>", "server project directory (default: current directory)")
    .action(() => {
      throw serverUsage("USAGE");
    });

  server.command("init")
    .description("Create a thin deployment project.")
    .argument("[directory]", "new or empty project directory")
    .option("--github <owner/repo>", "create and push an explicit GitHub repository")
    .option("--public", "create the GitHub repository as public")
    .option("--private", "create the GitHub repository as private (default)")
    .action(async (directory: string | undefined, options: Record<string, unknown>) => {
      if (options["public"] === true && options["private"] === true) {
        throw serverUsage("SERVER_VISIBILITY_CONFLICT", "CHOOSE_VISIBILITY");
      }
      if (typeof options["github"] !== "string" && (options["public"] === true || options["private"] === true)) {
        throw serverUsage("USAGE");
      }
      const parentProject = server.opts<{ project?: string }>()["project"];
      if (parentProject !== undefined && directory !== undefined) {
        throw serverUsage("SERVER_PROJECT_AMBIGUOUS", "CHOOSE_PROJECT_DIRECTORY");
      }
      const ctx = context(io, globals, overrides);
      const result = await runServerInit(
        { io, runner: ctx.runner, ...(ctx.randomUUID === undefined ? {} : { randomUUID: ctx.randomUUID }) },
        {
          ...(directory === undefined ? {} : { directory }),
          ...(parentProject === undefined ? {} : { projectDirectory: parentProject }),
          ...(typeof options["github"] === "string" ? { github: options["github"] } : {}),
          ...(options["public"] === true ? { visibility: "public" as const } : {}),
          ...(options["private"] === true ? { visibility: "private" as const } : {}),
        },
      );
      ctx.report(result, [
        result.status === "unchanged"
          ? `Syndroo project is already initialized: ${result.projectDirectory}`
          : `Syndroo project initialized: ${result.projectDirectory}`,
      ]);
    });

  server.command("doctor")
    .description("Run read-only project, deployment and tool checks.")
    .action(async () => {
      const ctx = context(io, globals, overrides, server.opts<{ project?: string }>()["project"]);
      const result = await runServerDoctor({
        cwd: io.cwd,
        runner: ctx.runner,
        env: io.env,
        stateRoot: ctx.stateRoot,
        ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
        ...(ctx.projectDirectory === undefined ? {} : { projectDirectory: ctx.projectDirectory }),
      });
      ctx.report(result, [
        `Syndroo doctor: ${result.status}`,
        ...result.checks.map((check) => `  ${check.name}: ${check.status}`),
      ]);
      state.exit = result.status === "ok" ? EXIT_CODE.SUCCESS : EXIT_CODE.FAILURE;
    });

  server.command("deploy")
    .description("Provision or update the configured Cloudflare deployment.")
    .option("--account <id>")
    .option("--recover <path>", "nonsecret recovery JSON path, or - for stdin")
    .option("--credentials-stdin", "read deployment credentials JSON from stdin")
    .option("--yes", "explicitly authorize this deployment")
    .action(async (options: Record<string, unknown>) => {
      const ctx = context(io, globals, overrides, server.opts<{ project?: string }>()["project"]);
      if (options["recover"] === "-" && options["credentialsStdin"] === true) {
        throw serverUsage("INPUT_SOURCE_CONFLICT", "USE_ONE_STDIN_INPUT");
      }
      const recover = typeof options["recover"] === "string"
        ? parseRecovery(await readBoundedInput(io, options["recover"], MAX_RECOVERY_BYTES))
        : undefined;
      const credentials = options["credentialsStdin"] === true
        ? parseCredentials(await readBoundedInput(io, "-", MAX_CREDENTIAL_BYTES))
        : undefined;
      const readCredential = !globals.json && io.hasTty() && io.readHiddenTtyLine !== undefined
        ? async (name: string): Promise<string | undefined> => {
            io.writeTty?.(`${name}: `);
            const value = await io.readHiddenTtyLine?.(600_000, io.signal);
            io.writeTty?.("\n");
            return value;
          }
        : undefined;
      const dependencies: ServerDeployDependencies = {
        cwd: io.cwd,
        runner: ctx.runner,
        env: io.env,
        stateRoot: ctx.stateRoot,
        ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
        ...(ctx.randomBytes === undefined ? {} : { randomBytes: ctx.randomBytes }),
      };
      const deployOptions: ServerDeployOptions = {
        authorized: options["yes"] === true,
        ...(ctx.projectDirectory === undefined ? {} : { projectDirectory: ctx.projectDirectory }),
        ...(typeof options["account"] === "string" ? { account: options["account"] } : {}),
        ...(recover === undefined ? {} : { recover }),
        ...(credentials === undefined ? {} : { credentials }),
        ...(readCredential === undefined ? {} : { readCredential }),
      };
      const result = await (overrides.runDeploy ?? runServerDeploy)(dependencies, deployOptions);
      ctx.report(result, [
        `Syndroo deployment: ${result.status}`,
        `Worker: ${result.workerName}`,
        `Origin: ${result.origin}`,
      ]);
    });

  const connect = server.command("connect").description("Connect a deployment provider.");
  connect.command("threads")
    .description("Authorize one Threads account through the deployed server.")
    .option("--app-id <id>")
    .option("--request-id <id>")
    .option("--app-secret-stdin", "read the app secret from stdin")
    .option(
      "--restart",
      "with a different --request-id, abandon a pending Threads attempt",
    )
    .option("--timeout-ms <number>")
    .option("--interval-ms <number>")
    .action(async (options: Record<string, unknown>) => {
      const ctx = context(io, globals, overrides, server.opts<{ project?: string }>()["project"]);
      const result = await runServerThreadsConnect(
        {
          io,
          projectDirectory: projectDirectory(ctx),
          stateRoot: ctx.stateRoot,
          env: io.env,
          json: globals.json,
          sleepMs: integerOption(
            options["timeoutMs"],
            BOOTSTRAP_TIMEOUT_LIMITS.defaultMs,
            BOOTSTRAP_TIMEOUT_LIMITS.minMs,
            BOOTSTRAP_TIMEOUT_LIMITS.maxMs,
          ),
          waitTimeoutMs: integerOption(
            options["timeoutMs"],
            BOOTSTRAP_TIMEOUT_LIMITS.defaultMs,
            BOOTSTRAP_TIMEOUT_LIMITS.minMs,
            BOOTSTRAP_TIMEOUT_LIMITS.maxMs,
          ),
          pollIntervalMs: integerOption(
            options["intervalMs"],
            PUBLISH_WAIT_LIMITS.defaultIntervalMs,
            PUBLISH_WAIT_LIMITS.minIntervalMs,
            PUBLISH_WAIT_LIMITS.maxIntervalMs,
          ),
          ...(overrides.threadsClientFactory === undefined
            ? {}
            : { clientFactory: overrides.threadsClientFactory }),
          ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
          ...(ctx.randomUUID === undefined ? {} : { randomUUID: ctx.randomUUID }),
          ...(typeof overrides.now === "function" ? { now: overrides.now as () => number } : {}),
        },
        {
          appSecretStdin: options["appSecretStdin"] === true,
          restart: options["restart"] === true,
          ...(typeof options["appId"] === "string" ? { appId: options["appId"] } : {}),
          ...(typeof options["requestId"] === "string" ? { requestId: options["requestId"] } : {}),
        },
      );
      ctx.report(result, [
        `Threads connection: ${result.connectionId}`,
        `Callback URL: ${result.callbackUrl}`,
      ]);
    });

  const publish = server.command("publish").description("Publish through the deployed server.");
  publish.command("threads")
    .description("Publish one Threads post with a scoped CI token.")
    .option("--input <file>")
    .option("--request-id <id>")
    .option("--wait-timeout-ms <number>")
    .option("--interval-ms <number>")
    .option("--yes")
    .action(async (options: Record<string, unknown>) => {
      const ctx = context(io, globals, overrides, server.opts<{ project?: string }>()["project"]);
      const result = await runServerThreadsPublish(
        {
          io,
          projectDirectory: projectDirectory(ctx),
          stateRoot: ctx.stateRoot,
          env: io.env,
          json: globals.json,
          sleepMs: PUBLISH_WAIT_LIMITS.defaultMs,
          waitTimeoutMs: integerOption(
            options["waitTimeoutMs"],
            PUBLISH_WAIT_LIMITS.defaultMs,
            PUBLISH_WAIT_LIMITS.minMs,
            PUBLISH_WAIT_LIMITS.maxMs,
          ),
          pollIntervalMs: integerOption(
            options["intervalMs"],
            PUBLISH_WAIT_LIMITS.defaultIntervalMs,
            PUBLISH_WAIT_LIMITS.minIntervalMs,
            PUBLISH_WAIT_LIMITS.maxIntervalMs,
          ),
          ...(overrides.threadsClientFactory === undefined
            ? {}
            : { clientFactory: overrides.threadsClientFactory }),
          ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
        },
        {
          yes: options["yes"] === true,
          ...(typeof options["input"] === "string" ? { input: options["input"] } : {}),
          ...(typeof options["requestId"] === "string" ? { requestId: options["requestId"] } : {}),
        },
      );
      ctx.report(result, [
        `Threads publication: ${result.status}`,
        `Operation: ${result.operationId}`,
      ]);
      state.exit = result.exitCode;
    });

  const ci = server.command("ci").description("Configure manual publishing CI.");
  const setup = ci.command("setup").description("Prepare CI settings.");
  setup.command("github")
    .description("Install the manual Threads workflow and environment.")
    .option("--repo <owner/repo>")
    .option("--ci-token-stdin", "recover an existing CI bearer from stdin")
    .option("--yes")
    .action(async (options: Record<string, unknown>) => {
      const ctx = context(io, globals, overrides, server.opts<{ project?: string }>()["project"]);
      const environmentBearer = io.env["SYNDROO_CI_BEARER"];
      const stdinBearer = options["ciTokenStdin"] === true
        ? Buffer.from(
            await readBoundedInput(io, "-", MAX_CREDENTIAL_BYTES),
          ).toString("utf8").trim()
        : undefined;
      if (
        environmentBearer !== undefined &&
        stdinBearer !== undefined &&
        environmentBearer !== stdinBearer
      ) {
        throw serverUsage("INPUT_SOURCE_CONFLICT", "PROVIDE_ONE_CI_BEARER");
      }
      const ciBearer = stdinBearer ?? environmentBearer;
      const result = await runServerGithubCi(
        {
          cwd: io.cwd,
          stateRoot: ctx.stateRoot,
          runner: ctx.runner,
          env: io.env,
          ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
          ...(ctx.projectDirectory === undefined ? {} : { projectDirectory: ctx.projectDirectory }),
          ...(ctx.randomBytes === undefined ? {} : { randomBytes: ctx.randomBytes }),
          ...(typeof overrides.now === "function"
            ? { now: overrides.now as () => string }
            : {}),
        },
        {
          yes: options["yes"] === true,
          ...(ciBearer === undefined ? {} : { ciBearer }),
          ...(typeof options["repo"] === "string" ? { repo: options["repo"] } : {}),
        },
      );
      ctx.report(result, [
        `GitHub CI: ${result.status}`,
        `Repository: ${result.repository}`,
        `Workflow: ${result.workflow}`,
      ]);
    });
}
