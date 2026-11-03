import { CliError } from "../cli-error.js";
import { EXIT_CODE } from "../exit-codes.js";
import type { ProcessResult, ProcessRunner } from "./process.js";

export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
export const CLOUDFLARE_API_BASE = `${CLOUDFLARE_API_ORIGIN}/client/v4`;

const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const WORKER_ABSENT_CODES = new Set([10007, 10090]);
const WRANGLER_ENVIRONMENT = { WRANGLER_SEND_METRICS: "false" } as const;

export type CloudflareIdentity = {
  readonly accountId: string;
  readonly accountName: string;
};

export type CloudflareSession = CloudflareIdentity & {
  /** Keep this value in memory only; never put it in state, output, or argv. */
  readonly token: string;
};

export type CloudflareWorker = {
  readonly tag: string;
};

export type CloudflareResource = {
  readonly id: string;
  readonly name: string;
};

export type CloudflareApi = {
  worker(workerName: string): Promise<CloudflareWorker | null>;
  listD1(databaseName: string): Promise<CloudflareResource | null>;
  d1(databaseId: string): Promise<CloudflareResource | null>;
  createD1(databaseName: string): Promise<CloudflareResource>;
  listQueue(queueName: string): Promise<CloudflareResource | null>;
  queue(queueId: string): Promise<CloudflareResource | null>;
  createQueue(queueName: string): Promise<CloudflareResource>;
  workersDevSubdomain(): Promise<string>;
};

export class CloudflareApiError extends Error {
  readonly apiCode: number | undefined;
  readonly status: number | undefined;
  readonly mutation: boolean;

  constructor(options: {
    readonly apiCode?: number;
    readonly status?: number;
    readonly mutation: boolean;
  }) {
    super("CLOUDFLARE_API_ERROR");
    this.name = "CloudflareApiError";
    this.apiCode = options.apiCode;
    this.status = options.status;
    this.mutation = options.mutation;
  }
}

function deploymentError(
  code: string,
  nextAction?: string,
  exitCode: ExitCode = EXIT_CODE.FAILURE,
): CliError {
  return new CliError(code, {
    code,
    exitCode,
    details: nextAction === undefined ? {} : { nextAction },
  });
}

type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

function processFailure(result: ProcessResult, code: string): CliError {
  if (result.status === "spawn_error") {
    return deploymentError(code, "INSTALL_PROJECT_WRANGLER", EXIT_CODE.USAGE);
  }
  if (result.status === "timed_out") {
    return deploymentError("SERVER_DEPLOY_AUTH_TIMEOUT", "RETRY_DEPLOY");
  }
  if (result.status === "output_limit") {
    return deploymentError("SERVER_DEPLOY_AUTH_OUTPUT_LIMIT", "CHECK_WRANGLER_CONFIGURATION");
  }
  return deploymentError(code, "AUTHENTICATE_CLOUDFLARE", EXIT_CODE.USAGE);
}

function parseOutputJson(
  result: ProcessResult,
  code: string,
): Record<string, unknown> {
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw processFailure(result, code);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw deploymentError(code, "CHECK_CLOUDFLARE_AUTH");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw deploymentError(code, "CHECK_CLOUDFLARE_AUTH");
  }
  return value as Record<string, unknown>;
}

export function assertCloudflareApiEnvironment(env: NodeJS.ProcessEnv): void {
  const base = env["CLOUDFLARE_API_BASE_URL"];
  if (
    base !== undefined &&
    base.replace(/\/+$/, "") !== CLOUDFLARE_API_BASE
  ) {
    throw deploymentError(
      "SERVER_DEPLOY_API_ORIGIN_UNSUPPORTED",
      "UNSET_CLOUDFLARE_API_BASE_URL",
      EXIT_CODE.USAGE,
    );
  }

  const compliance = env["CLOUDFLARE_COMPLIANCE_REGION"];
  if (
    compliance !== undefined &&
    compliance !== "" &&
    compliance !== "public"
  ) {
    throw deploymentError(
      "SERVER_DEPLOY_API_ORIGIN_UNSUPPORTED",
      "UNSET_CLOUDFLARE_COMPLIANCE_REGION",
      EXIT_CODE.USAGE,
    );
  }

  const wranglerEnvironment = env["WRANGLER_API_ENVIRONMENT"];
  if (
    wranglerEnvironment !== undefined &&
    wranglerEnvironment !== "" &&
    wranglerEnvironment !== "production"
  ) {
    throw deploymentError(
      "SERVER_DEPLOY_API_ORIGIN_UNSUPPORTED",
      "UNSET_WRANGLER_API_ENVIRONMENT",
      EXIT_CODE.USAGE,
    );
  }
}

export async function resolveCloudflareSession(
  runner: ProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  requestedAccount?: string,
): Promise<CloudflareSession> {
  assertCloudflareApiEnvironment(env);
  const whoamiResult = await runner.run({
    tool: "wrangler",
    args: ["whoami", "--json"],
    cwd,
    environment: WRANGLER_ENVIRONMENT,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
  });
  const whoami = parseOutputJson(
    whoamiResult,
    "SERVER_DEPLOY_CLOUDFLARE_AUTH_REQUIRED",
  );
  if (whoami["loggedIn"] !== true) {
    throw deploymentError(
      "SERVER_DEPLOY_CLOUDFLARE_AUTH_REQUIRED",
      "AUTHENTICATE_CLOUDFLARE",
      EXIT_CODE.USAGE,
    );
  }
  if (
    typeof whoami["authType"] === "string" &&
    /api key/i.test(whoami["authType"])
  ) {
    throw deploymentError(
      "SERVER_DEPLOY_CLOUDFLARE_AUTH_UNSUPPORTED",
      "USE_OAUTH_OR_API_TOKEN",
      EXIT_CODE.USAGE,
    );
  }
  if (!Array.isArray(whoami["accounts"])) {
    throw deploymentError(
      "SERVER_DEPLOY_CLOUDFLARE_AUTH_REQUIRED",
      "AUTHENTICATE_CLOUDFLARE",
      EXIT_CODE.USAGE,
    );
  }

  const accounts = whoami["accounts"].flatMap((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { id?: unknown }).id !== "string" ||
      typeof (value as { name?: unknown }).name !== "string"
    ) {
      return [];
    }
    return [{
      id: (value as { id: string }).id,
      name: (value as { name: string }).name,
    }];
  });
  const matches = requestedAccount === undefined
    ? accounts
    : accounts.filter(
        (account) =>
          account.id === requestedAccount ||
          account.name === requestedAccount,
      );
  const identities = new Map(matches.map((account) => [account.id, account]));
  if (identities.size !== 1) {
    throw deploymentError(
      "SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED",
      matches.length > 1 ? "SELECT_ACCOUNT_ID" : "SELECT_CLOUDFLARE_ACCOUNT",
      EXIT_CODE.USAGE,
    );
  }
  const account = identities.values().next().value as
    | { readonly id: string; readonly name: string }
    | undefined;
  if (account === undefined) {
    throw deploymentError(
      "SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED",
      "SELECT_CLOUDFLARE_ACCOUNT",
      EXIT_CODE.USAGE,
    );
  }

  const tokenResult = await runner.run({
    tool: "wrangler",
    args: ["auth", "token", "--json"],
    cwd,
    environment: WRANGLER_ENVIRONMENT,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
  });
  const auth = parseOutputJson(
    tokenResult,
    "SERVER_DEPLOY_CLOUDFLARE_AUTH_REQUIRED",
  );
  if (auth["type"] !== "oauth" && auth["type"] !== "api_token") {
    throw deploymentError(
      "SERVER_DEPLOY_CLOUDFLARE_AUTH_UNSUPPORTED",
      "USE_OAUTH_OR_API_TOKEN",
      EXIT_CODE.USAGE,
    );
  }
  if (
    typeof auth["token"] !== "string" ||
    auth["token"].length === 0 ||
    auth["token"].length > 8_192 ||
    auth["token"].includes("\u0000")
  ) {
    throw deploymentError(
      "SERVER_DEPLOY_CLOUDFLARE_AUTH_REQUIRED",
      "AUTHENTICATE_CLOUDFLARE",
      EXIT_CODE.USAGE,
    );
  }

  return {
    accountId: account.id,
    accountName: account.name,
    token: auth["token"],
  };
}

type ApiEnvelope = {
  readonly success: boolean;
  readonly result?: unknown;
  readonly errors?: unknown;
};

function apiCode(errors: unknown): number | undefined {
  if (!Array.isArray(errors)) {
    return undefined;
  }
  for (const error of errors) {
    if (
      typeof error === "object" &&
      error !== null &&
      Number.isSafeInteger((error as { code?: unknown }).code)
    ) {
      return (error as { code: number }).code;
    }
  }
  return undefined;
}

function validateResource(
  value: unknown,
  idKey: "uuid" | "queue_id",
  nameKey: "name" | "queue_name",
): CloudflareResource {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>)[idKey] !== "string" ||
    typeof (value as Record<string, unknown>)[nameKey] !== "string"
  ) {
    throw new CloudflareApiError({ mutation: true });
  }
  return {
    id: (value as Record<string, string>)[idKey] as string,
    name: (value as Record<string, string>)[nameKey] as string,
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw deploymentError(
        "SERVER_DEPLOY_REMOTE_OUTPUT_LIMIT",
        "RETRY_DEPLOY",
      );
    }
    chunks.push(chunk.value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    );
  } catch {
    throw new CloudflareApiError({ mutation: false });
  }
}

export function createCloudflareApi(options: {
  readonly accountId: string;
  readonly token: string;
  readonly fetch: typeof fetch;
}): CloudflareApi {
  const base = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(options.accountId)}`;

  const request = async (
    method: "GET" | "POST",
    relative: string,
    body?: unknown,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await options.fetch(`${base}${relative}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new CloudflareApiError({ mutation: method === "POST" });
    } finally {
      clearTimeout(timeout);
    }

    let text: string;
    try {
      text = await boundedResponseText(response);
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      throw new CloudflareApiError({
        status: response.status,
        mutation: method === "POST",
      });
    }

    let envelope: ApiEnvelope;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("invalid envelope");
      }
      envelope = parsed as ApiEnvelope;
    } catch {
      throw new CloudflareApiError({
        status: response.status,
        mutation: method === "POST",
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw deploymentError(
        "SERVER_DEPLOY_AUTH_OR_PERMISSION",
        "CHECK_CLOUDFLARE_ACCOUNT_PERMISSIONS",
        EXIT_CODE.USAGE,
      );
    }
    if (!response.ok || envelope.success !== true) {
      const code = apiCode(envelope.errors);
      throw new CloudflareApiError({
        status: response.status,
        ...(code === undefined ? {} : { apiCode: code }),
        mutation: method === "POST",
      });
    }
    return envelope.result;
  };

  const listNamed = async (
    collection: "d1/database" | "queues",
    idKey: "uuid" | "queue_id",
    nameKey: "name" | "queue_name",
    requestedName: string,
    nameQuery: boolean,
  ): Promise<CloudflareResource | null> => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({
        page: String(page),
        per_page: String(PAGE_SIZE),
        ...(nameQuery ? { name: requestedName } : {}),
      });
      let result: unknown;
      try {
        result = await request("GET", `/${collection}?${query}`);
      } catch (error) {
        if (error instanceof CliError) {
          throw error;
        }
        throw deploymentError(
          "SERVER_DEPLOY_REMOTE_READ_FAILED",
          "RETRY_DEPLOY",
        );
      }
      if (!Array.isArray(result)) {
        throw deploymentError(
          "SERVER_DEPLOY_REMOTE_READ_FAILED",
          "RETRY_DEPLOY",
        );
      }
      for (const value of result) {
        try {
          const resource = validateResource(value, idKey, nameKey);
          if (resource.name === requestedName) {
            return resource;
          }
        } catch {
          throw deploymentError(
            "SERVER_DEPLOY_REMOTE_READ_FAILED",
            "RETRY_DEPLOY",
          );
        }
      }
      if (result.length < PAGE_SIZE) {
        return null;
      }
    }
    throw deploymentError("SERVER_DEPLOY_REMOTE_READ_FAILED", "RETRY_DEPLOY");
  };

  return {
    async worker(workerName) {
      try {
        const result = await request(
          "GET",
          `/workers/services/${encodeURIComponent(workerName)}`,
        );
        const tag =
          typeof result === "object" &&
          result !== null &&
          typeof (result as {
            default_environment?: { script?: { tag?: unknown } };
          }).default_environment?.script?.tag === "string"
            ? (result as {
                default_environment: { script: { tag: string } };
              }).default_environment.script.tag
            : undefined;
        if (tag === undefined) {
          throw deploymentError(
            "SERVER_DEPLOY_REMOTE_READ_FAILED",
            "RETRY_DEPLOY",
          );
        }
        return { tag };
      } catch (error) {
        if (
          error instanceof CloudflareApiError &&
          error.apiCode !== undefined &&
          WORKER_ABSENT_CODES.has(error.apiCode)
        ) {
          return null;
        }
        if (error instanceof CliError) {
          throw error;
        }
        throw deploymentError(
          "SERVER_DEPLOY_REMOTE_READ_FAILED",
          "RETRY_DEPLOY",
        );
      }
    },
    async listD1(databaseName) {
      return await listNamed(
        "d1/database",
        "uuid",
        "name",
        databaseName,
        false,
      );
    },
    async d1(databaseId) {
      try {
        return validateResource(
          await request(
            "GET",
            `/d1/database/${encodeURIComponent(databaseId)}`,
          ),
          "uuid",
          "name",
        );
      } catch (error) {
        if (error instanceof CliError) {
          throw error;
        }
        if (
          error instanceof CloudflareApiError &&
          !error.mutation &&
          error.status !== 401 &&
          error.status !== 403
        ) {
          return null;
        }
        throw deploymentError(
          "SERVER_DEPLOY_REMOTE_READ_FAILED",
          "RETRY_DEPLOY",
        );
      }
    },
    async createD1(databaseName) {
      const result = await request("POST", "/d1/database", {
        name: databaseName,
      }).catch((error: unknown) => {
        if (
          error instanceof CloudflareApiError &&
          error.apiCode === 7502
        ) {
          throw deploymentError(
            "SERVER_DEPLOY_AMBIGUOUS",
            "INSPECT_CLOUDFLARE_RESOURCES",
          );
        }
        if (
          error instanceof CloudflareApiError &&
          error.apiCode === 7406
        ) {
          throw deploymentError(
            "SERVER_DEPLOY_D1_LIMIT_REACHED",
            "FREE_D1_CAPACITY",
          );
        }
        if (error instanceof CliError) {
          throw error;
        }
        throw deploymentError(
          "SERVER_DEPLOY_AMBIGUOUS",
          "INSPECT_CLOUDFLARE_RESOURCES",
        );
      });
      const resource = validateResource(result, "uuid", "name");
      if (resource.name !== databaseName) {
        throw deploymentError(
          "SERVER_DEPLOY_AMBIGUOUS",
          "INSPECT_CLOUDFLARE_RESOURCES",
        );
      }
      return resource;
    },
    async listQueue(queueName) {
      return await listNamed(
        "queues",
        "queue_id",
        "queue_name",
        queueName,
        true,
      );
    },
    async queue(queueId) {
      try {
        return validateResource(
          await request(
            "GET",
            `/queues/${encodeURIComponent(queueId)}`,
          ),
          "queue_id",
          "queue_name",
        );
      } catch (error) {
        if (error instanceof CliError) {
          throw error;
        }
        if (
          error instanceof CloudflareApiError &&
          !error.mutation &&
          error.status !== 401 &&
          error.status !== 403
        ) {
          return null;
        }
        throw deploymentError(
          "SERVER_DEPLOY_REMOTE_READ_FAILED",
          "RETRY_DEPLOY",
        );
      }
    },
    async createQueue(queueName) {
      let result: unknown;
      try {
        result = await request("POST", "/queues", {
          queue_name: queueName,
        });
      } catch (error) {
        if (
          error instanceof CloudflareApiError &&
          error.mutation &&
          error.apiCode === undefined
        ) {
          throw deploymentError(
            "SERVER_DEPLOY_AMBIGUOUS",
            "INSPECT_CLOUDFLARE_RESOURCES",
          );
        }
        if (error instanceof CloudflareApiError) {
          throw deploymentError(
            "SERVER_DEPLOY_AMBIGUOUS",
            "INSPECT_CLOUDFLARE_RESOURCES",
          );
        }
        throw error;
      }
      const resource = validateResource(result, "queue_id", "queue_name");
      if (resource.name !== queueName) {
        throw deploymentError(
          "SERVER_DEPLOY_AMBIGUOUS",
          "INSPECT_CLOUDFLARE_RESOURCES",
        );
      }
      return resource;
    },
    async workersDevSubdomain() {
      let result: unknown;
      try {
        result = await request("GET", "/workers/subdomain");
      } catch (error) {
        if (
          error instanceof CloudflareApiError &&
          error.apiCode !== undefined &&
          WORKER_ABSENT_CODES.has(error.apiCode)
        ) {
          throw deploymentError(
            "SERVER_DEPLOY_WORKERS_DEV_SUBDOMAIN_REQUIRED",
            "REGISTER_WORKERS_DEV_SUBDOMAIN",
            EXIT_CODE.USAGE,
          );
        }
        if (error instanceof CliError) {
          throw error;
        }
        throw deploymentError(
          "SERVER_DEPLOY_REMOTE_READ_FAILED",
          "RETRY_DEPLOY",
        );
      }
      const subdomain =
        typeof result === "object" &&
        result !== null &&
        typeof (result as { subdomain?: unknown }).subdomain === "string"
          ? (result as { subdomain: string }).subdomain
          : undefined;
      if (
        subdomain === undefined ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)
      ) {
        throw deploymentError(
          "SERVER_DEPLOY_WORKERS_DEV_SUBDOMAIN_REQUIRED",
          "REGISTER_WORKERS_DEV_SUBDOMAIN",
          EXIT_CODE.USAGE,
        );
      }
      return subdomain;
    },
  };
}
