import {
  defaultSleep,
  isSyndrooError,
  type ConnectRequest,
  type ConnectResult,
  type ExecutionResult,
  type PrepareRequest,
  type PublishRequest,
  type PublishResult,
  type RequestOptions,
  type SleepLike,
  type WaitOptions,
} from "@syndroo/sdk";

export const THREADS_CALLBACK_PATH = "/oauth/callback/threads";
export const MAX_POST_BYTES = 65_536;
export const BOOTSTRAP_TIMEOUT_LIMITS = Object.freeze({
  defaultMs: 600_000,
  minMs: 250,
  maxMs: 900_000,
});
export const PUBLISH_WAIT_LIMITS = Object.freeze({
  defaultMs: 120_000,
  minMs: 1,
  maxMs: 3_600_000,
  defaultIntervalMs: 2_000,
  minIntervalMs: 250,
  maxIntervalMs: 30_000,
});

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type ThreadsCiErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_ARGUMENT"
  | "INVALID_POST"
  | "INVALID_RESPONSE"
  | "AUTHORIZATION_EXPIRED"
  | "CALLBACK_TIMEOUT"
  | "CREDENTIALS_REQUIRED_AGAIN";

/** A static, secret-free error suitable for command output. */
export class ThreadsCiError extends Error {
  readonly code: ThreadsCiErrorCode;
  readonly exitCode: number;

  constructor(code: ThreadsCiErrorCode, message: string, exitCode = 2) {
    super(message);
    this.name = "ThreadsCiError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * The subset of `Syndroo` these helpers use. Tests can provide a fake SDK while
 * production wrappers pass the real client.
 */
export type ThreadsCiSdk = {
  connect(request: ConnectRequest, options?: RequestOptions): Promise<ConnectResult>;
  publish(request: PublishRequest, options?: RequestOptions): Promise<PublishResult>;
  wait(operationId: string, options?: WaitOptions): Promise<ExecutionResult>;
};

export type BootstrapOptions = {
  readonly client: ThreadsCiSdk;
  readonly syndrooUrl: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: SleepLike;
  readonly now?: () => number;
  readonly onAuthorization?: (instructions: {
    readonly url: string;
    readonly expiresAt: string;
    readonly callbackUrl: string;
  }) => void;
};

export type BootstrapResult = {
  readonly status: "connected";
  readonly provider: "threads";
  readonly connectionId: string;
  readonly accountName?: string;
  readonly callbackUrl: string;
};

export type PublishOptions = {
  readonly client: ThreadsCiSdk;
  readonly connectionId: string;
  readonly requestId: string;
  readonly text: string;
  readonly yes: boolean;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
};

export type PublicDelivery = {
  readonly connectionId: string;
  readonly status: "succeeded" | "failed" | "unknown" | "not_started" | "unresolved";
  readonly attempts: number;
  readonly url?: string;
  readonly reason?: string;
};

export type PublishRunResult = {
  readonly status:
    | "succeeded"
    | "pending"
    | "running"
    | "partial"
    | "failed"
    | "unknown"
    | "timeout"
    | "status_unavailable";
  readonly provider: "threads";
  readonly operationId: string;
  readonly connectionId: string;
  readonly deliveries: readonly PublicDelivery[];
  readonly exitCode: 0 | 1;
  readonly message?: string;
  readonly errorCode?: string;
};

export type BootstrapArguments = {
  readonly help: boolean;
  readonly requestId?: string;
  readonly timeoutMs: number;
  readonly intervalMs: number;
};

export type PublishArguments = {
  readonly help: boolean;
  readonly input?: string;
  readonly requestId?: string;
  readonly yes: boolean;
  readonly waitTimeoutMs: number;
  readonly pollIntervalMs: number;
};

export const BOOTSTRAP_USAGE = `Usage: node .build/scripts/threads-connect.js [options]

Environment:
  SYNDROO_URL          Canonical HTTPS deployment origin
  SYNDROO_ADMIN_TOKEN  Remote deployment admin bearer
  THREADS_APP_ID       Threads app client id
  THREADS_APP_SECRET   Threads app client secret

Options:
  --request-id <id>         Reuse one connect-start request identity
  --timeout-ms <number>     Callback wait budget (250..900000)
  --interval-ms <number>    Callback poll interval (250..30000)
  --help                    Show this help`;

export const PUBLISH_USAGE = `Usage: node .build/scripts/threads-publish.js --input <post.json> --request-id <id> --yes [options]

Environment:
  SYNDROO_URL            Canonical HTTPS deployment origin
  SYNDROO_TOKEN          CI bearer scoped to one Threads connection
  SYNDROO_CONNECTION_ID  Exact Threads connection id

Options:
  --yes                      Explicitly approve this frozen publication
  --wait-timeout-ms <number> Status wait budget (1..3600000)
  --interval-ms <number>     Status poll interval (250..30000)
  --help                     Show this help`;

/**
 * Accept only a canonical HTTPS origin. Credentials, paths, queries and
 * fragments are rejected because they could make the OAuth callback ambiguous.
 */
export function parseCanonicalHttpsOrigin(raw: string): string {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) {
    throw new ThreadsCiError("INVALID_CONFIGURATION", "SYNDROO_URL must be a canonical HTTPS origin.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ThreadsCiError("INVALID_CONFIGURATION", "SYNDROO_URL must be a canonical HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new ThreadsCiError("INVALID_CONFIGURATION", "SYNDROO_URL must be a canonical HTTPS origin.");
  }
  return url.origin;
}

export function threadsCallbackUrl(origin: string): string {
  return `${parseCanonicalHttpsOrigin(origin)}${THREADS_CALLBACK_PATH}`;
}

export function assertRequestId(value: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new ThreadsCiError(
      "INVALID_ARGUMENT",
      "The request id must be 1..128 characters from A-Z, a-z, 0-9, dot, underscore, colon or hyphen.",
    );
  }
  return value;
}

export function assertConnectionId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\r\n\u0000]/.test(value)
  ) {
    throw new ThreadsCiError("INVALID_CONFIGURATION", "SYNDROO_CONNECTION_ID is missing or invalid.");
  }
  return value;
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ThreadsCiError(
      "INVALID_ARGUMENT",
      `${name} must be an integer from ${min} through ${max}.`,
    );
  }
  return value;
}

/**
 * Parse the one-file post format. It intentionally rejects extra properties so
 * a caller cannot smuggle options, targets or credentials beside the text.
 */
export function parseThreadsPostBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_POST_BYTES) {
    throw new ThreadsCiError(
      "INVALID_POST",
      `The post file must contain 1..${MAX_POST_BYTES} bytes.`,
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ThreadsCiError("INVALID_POST", "The post file must be valid UTF-8 JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ThreadsCiError("INVALID_POST", "The post file must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ThreadsCiError("INVALID_POST", 'The post must be an object shaped exactly like {"text":"..."}.');
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "text") {
    throw new ThreadsCiError("INVALID_POST", 'The post must contain exactly one property named "text".');
  }
  const text = (parsed as { readonly text?: unknown }).text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ThreadsCiError("INVALID_POST", 'The post "text" must be a non-empty string.');
  }
  return text;
}

export function parseBootstrapArguments(args: readonly string[]): BootstrapArguments {
  let help = false;
  let requestId: string | undefined;
  let timeoutMs: number = BOOTSTRAP_TIMEOUT_LIMITS.defaultMs;
  let intervalMs: number = PUBLISH_WAIT_LIMITS.defaultIntervalMs;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag !== "--request-id" && flag !== "--timeout-ms" && flag !== "--interval-ms") {
      throw new ThreadsCiError("INVALID_ARGUMENT", "Unknown bootstrap argument.");
    }
    if (seen.has(flag)) {
      throw new ThreadsCiError("INVALID_ARGUMENT", "A bootstrap option was supplied more than once.");
    }
    seen.add(flag);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ThreadsCiError("INVALID_ARGUMENT", "A bootstrap option is missing its value.");
    }
    index += 1;
    if (flag === "--request-id") {
      requestId = assertRequestId(value);
      continue;
    }
    const parsed = Number(value);
    if (flag === "--timeout-ms") {
      timeoutMs = boundedInteger(
        parsed,
        BOOTSTRAP_TIMEOUT_LIMITS.minMs,
        BOOTSTRAP_TIMEOUT_LIMITS.maxMs,
        "The callback timeout",
      );
    } else {
      intervalMs = boundedInteger(
        parsed,
        PUBLISH_WAIT_LIMITS.minIntervalMs,
        PUBLISH_WAIT_LIMITS.maxIntervalMs,
        "The callback interval",
      );
    }
  }

  return {
    help,
    ...(requestId === undefined ? {} : { requestId }),
    timeoutMs,
    intervalMs,
  };
}

export function parsePublishArguments(args: readonly string[]): PublishArguments {
  let help = false;
  let yes = false;
  let input: string | undefined;
  let requestId: string | undefined;
  let waitTimeoutMs: number = PUBLISH_WAIT_LIMITS.defaultMs;
  let pollIntervalMs: number = PUBLISH_WAIT_LIMITS.defaultIntervalMs;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag === "--yes") {
      if (seen.has(flag)) {
        throw new ThreadsCiError("INVALID_ARGUMENT", "--yes may be supplied only once.");
      }
      seen.add(flag);
      yes = true;
      continue;
    }
    if (
      flag !== "--input" &&
      flag !== "--request-id" &&
      flag !== "--wait-timeout-ms" &&
      flag !== "--interval-ms"
    ) {
      throw new ThreadsCiError("INVALID_ARGUMENT", "Unknown publication argument.");
    }
    if (seen.has(flag)) {
      throw new ThreadsCiError("INVALID_ARGUMENT", "A publication option was supplied more than once.");
    }
    seen.add(flag);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ThreadsCiError("INVALID_ARGUMENT", "A publication option is missing its value.");
    }
    index += 1;
    if (flag === "--input") {
      if (value.trim().length === 0) {
        throw new ThreadsCiError("INVALID_ARGUMENT", "The input path must not be empty.");
      }
      input = value;
    } else if (flag === "--request-id") {
      requestId = assertRequestId(value);
    } else {
      const parsed = Number(value);
      if (flag === "--wait-timeout-ms") {
        waitTimeoutMs = boundedInteger(
          parsed,
          PUBLISH_WAIT_LIMITS.minMs,
          PUBLISH_WAIT_LIMITS.maxMs,
          "The status timeout",
        );
      } else {
        pollIntervalMs = boundedInteger(
          parsed,
          PUBLISH_WAIT_LIMITS.minIntervalMs,
          PUBLISH_WAIT_LIMITS.maxIntervalMs,
          "The status interval",
        );
      }
    }
  }

  if (!help && input === undefined) {
    throw new ThreadsCiError("INVALID_ARGUMENT", "--input is required.");
  }
  if (!help && requestId === undefined) {
    throw new ThreadsCiError("INVALID_ARGUMENT", "--request-id is required.");
  }
  if (!help && !yes) {
    throw new ThreadsCiError(
      "INVALID_ARGUMENT",
      "Publication requires the explicit --yes flag.",
    );
  }
  return {
    help,
    ...(input === undefined ? {} : { input }),
    ...(requestId === undefined ? {} : { requestId }),
    yes,
    waitTimeoutMs,
    pollIntervalMs,
  };
}

/**
 * Start and finish one remote Threads OAuth connect.
 *
 * The app credentials are passed only in the SDK connect body. The callback
 * loop sends `callback_complete` against the latest live step and never treats
 * a repeated action as a completed connection.
 */
export async function runThreadsBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const origin = parseCanonicalHttpsOrigin(options.syndrooUrl);
  const callbackUrl = threadsCallbackUrl(origin);
  if (typeof options.appId !== "string" || options.appId.length === 0) {
    throw new ThreadsCiError("INVALID_CONFIGURATION", "THREADS_APP_ID is missing.");
  }
  if (typeof options.appSecret !== "string" || options.appSecret.length === 0) {
    throw new ThreadsCiError("INVALID_CONFIGURATION", "THREADS_APP_SECRET is missing.");
  }
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? BOOTSTRAP_TIMEOUT_LIMITS.defaultMs,
    BOOTSTRAP_TIMEOUT_LIMITS.minMs,
    BOOTSTRAP_TIMEOUT_LIMITS.maxMs,
    "The callback timeout",
  );
  const intervalMs = boundedInteger(
    options.intervalMs ?? PUBLISH_WAIT_LIMITS.defaultIntervalMs,
    PUBLISH_WAIT_LIMITS.minIntervalMs,
    PUBLISH_WAIT_LIMITS.maxIntervalMs,
    "The callback interval",
  );
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const pollDeadline = startedAt + timeoutMs;

  const startOptions: RequestOptions = {
    transportRetries: 2,
    ...(options.requestId === undefined
      ? {}
      : { idempotencyKey: assertRequestId(options.requestId) }),
  };
  let current = await options.client.connect(
    {
      type: "start",
      provider: "threads",
      options: { redirectUri: callbackUrl },
    },
    startOptions,
  );

  if (current.status === "done") {
    return bootstrapDone(current, callbackUrl);
  }
  if (current.action.type !== "credential_input") {
    throw new ThreadsCiError(
      "INVALID_RESPONSE",
      "The Threads start step did not request the app credentials.",
      1,
    );
  }

  current = await options.client.connect({
    type: "resume",
    connectSessionId: current.connectSessionId,
    stepRevision: current.stepRevision,
    input: {
      type: "credentials",
      credentials: {
        client_id: options.appId,
        client_secret: options.appSecret,
      },
    },
  });

  let shownAuthorizationStep = -1;
  for (;;) {
    if (current.status === "done") {
      return bootstrapDone(current, callbackUrl);
    }
    if (current.action.type === "credential_input") {
      throw new ThreadsCiError(
        "CREDENTIALS_REQUIRED_AGAIN",
        "Threads requested app credentials again after they were submitted.",
        1,
      );
    }

    const expiry = Date.parse(current.expiresAt);
    if (!Number.isFinite(expiry)) {
      throw new ThreadsCiError("INVALID_RESPONSE", "The Threads authorization expiry is invalid.", 1);
    }
    const currentTime = now();
    if (currentTime >= expiry) {
      throw new ThreadsCiError(
        "AUTHORIZATION_EXPIRED",
        "The Threads authorization expired; start the bootstrap again.",
        1,
      );
    }
    if (currentTime >= pollDeadline) {
      throw new ThreadsCiError(
        "CALLBACK_TIMEOUT",
        "Threads callback polling timed out; start the bootstrap again after checking the callback.",
        1,
      );
    }

    if (
      current.action.type === "open_url" &&
      current.stepRevision !== shownAuthorizationStep
    ) {
      shownAuthorizationStep = current.stepRevision;
      options.onAuthorization?.({
        url: current.action.url,
        expiresAt: current.expiresAt,
        callbackUrl,
      });
    }

    current = await options.client.connect({
      type: "resume",
      connectSessionId: current.connectSessionId,
      stepRevision: current.stepRevision,
      input: { type: "callback_complete" },
    });

    if (current.status === "done") {
      return bootstrapDone(current, callbackUrl);
    }
    if (current.action.type === "credential_input") {
      throw new ThreadsCiError(
        "CREDENTIALS_REQUIRED_AGAIN",
        "Threads requested app credentials again after they were submitted.",
        1,
      );
    }

    const remaining = Math.min(pollDeadline, expiry) - now();
    if (remaining <= 0) {
      const nextTime = now();
      if (nextTime >= expiry) {
        throw new ThreadsCiError(
          "AUTHORIZATION_EXPIRED",
          "The Threads authorization expired; start the bootstrap again.",
          1,
        );
      }
      throw new ThreadsCiError(
        "CALLBACK_TIMEOUT",
        "Threads callback polling timed out; start the bootstrap again after checking the callback.",
        1,
      );
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

function bootstrapDone(
  result: Extract<ConnectResult, { status: "done" }>,
  callbackUrl: string,
): BootstrapResult {
  const accountName = result.connection.presentation?.accountName;
  return {
    status: "connected",
    provider: "threads",
    connectionId: result.connection.connectionId,
    ...(accountName === undefined ? {} : { accountName }),
    callbackUrl,
  };
}

/**
 * Prepare, explicitly execute and status-wait one Threads publication.
 *
 * There is exactly one prepare at this layer. A replay returned by prepare
 * goes straight to status waiting. Any failed, partial, unknown, or unavailable
 * status exits nonzero and is never converted into another prepare or execute.
 */
export async function runThreadsPublish(options: PublishOptions): Promise<PublishRunResult> {
  if (options.yes !== true) {
    throw new ThreadsCiError(
      "INVALID_ARGUMENT",
      "Publication requires the explicit --yes flag.",
    );
  }
  const requestId = assertRequestId(options.requestId);
  const connectionId = assertConnectionId(options.connectionId);
  if (typeof options.text !== "string" || options.text.trim().length === 0) {
    throw new ThreadsCiError("INVALID_POST", 'The post "text" must be a non-empty string.');
  }
  const waitTimeoutMs = boundedInteger(
    options.waitTimeoutMs ?? PUBLISH_WAIT_LIMITS.defaultMs,
    PUBLISH_WAIT_LIMITS.minMs,
    PUBLISH_WAIT_LIMITS.maxMs,
    "The status timeout",
  );
  const pollIntervalMs = boundedInteger(
    options.pollIntervalMs ?? PUBLISH_WAIT_LIMITS.defaultIntervalMs,
    PUBLISH_WAIT_LIMITS.minIntervalMs,
    PUBLISH_WAIT_LIMITS.maxIntervalMs,
    "The status interval",
  );

  const prepare: PrepareRequest = {
    type: "prepare",
    content: { text: options.text },
    targets: [{ provider: "threads", connection: connectionId }],
  };
  const preparedOrReplayed = await options.client.publish(prepare, {
    idempotencyKey: requestId,
    transportRetries: 2,
  });

  let execution: ExecutionResult;
  if (isExecutionResult(preparedOrReplayed)) {
    execution = preparedOrReplayed;
  } else {
    try {
      const executed = await options.client.publish(
        {
          type: "execute",
          approvalToken: preparedOrReplayed.approvalToken,
        },
        { transportRetries: 2 },
      );
      if (!isExecutionResult(executed)) {
        throw new ThreadsCiError(
          "INVALID_RESPONSE",
          "The approval execution did not return an execution round.",
          1,
        );
      }
      execution = executed;
    } catch (error) {
      const errorCode = safeOperationErrorCode(error);
      return {
        status: "unknown",
        provider: "threads",
        operationId: preparedOrReplayed.operationId,
        connectionId,
        deliveries: [],
        exitCode: 1,
        message:
          "Execution response was unavailable; admission may have occurred. Inspect the operation, then rerun the same command with the same --request-id to recover. Never prepare with a new publication identity.",
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }
  }
  const operationId = execution.operationId;

  let settled: ExecutionResult;
  try {
    settled = await options.client.wait(operationId, {
      timeoutMs: waitTimeoutMs,
      intervalMs: pollIntervalMs,
    });
  } catch (error) {
    const status =
      isSyndrooError(error) && error.code === "WAIT_TIMEOUT"
        ? "timeout"
        : "status_unavailable";
    const errorCode = safeOperationErrorCode(error);
    return {
      status,
      provider: "threads",
      operationId,
      connectionId,
      deliveries: [],
      exitCode: 1,
      message:
        status === "timeout"
          ? "Status waiting timed out. Inspect the operation before deciding whether to retry."
          : errorCode === "UNAUTHORIZED" || errorCode === "FORBIDDEN"
            ? "Final status was rejected. Check the CI credential and connection scope, then inspect the operation."
            : "Final status is unavailable. Inspect the operation before deciding whether to retry.",
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }

  if (settled.operationId !== operationId) {
    return {
      status: "status_unavailable",
      provider: "threads",
      operationId,
      connectionId,
      deliveries: [],
      exitCode: 1,
      message: "The status response did not match the admitted operation.",
    };
  }

  const deliveries = settled.deliveries.map(publicDelivery);
  const fullySucceeded =
    settled.status === "succeeded" &&
    deliveries.length > 0 &&
    deliveries.every((delivery) => delivery.status === "succeeded");
  return {
    status: settled.status,
    provider: "threads",
    operationId,
    connectionId,
    deliveries,
    exitCode: fullySucceeded ? 0 : 1,
    ...(fullySucceeded
      ? {}
      : {
          message:
            "The operation did not fully succeed. Inspect the operation; do not republish automatically.",
        }),
  };
}

function isExecutionResult(result: PublishResult): result is ExecutionResult {
  return "phase" in result && result.phase === "execution";
}

function publicDelivery(delivery: ExecutionResult["deliveries"][number]): PublicDelivery {
  const outcome = delivery.outcome;
  if (outcome === null) {
    return {
      connectionId: delivery.connectionId,
      status: "unresolved",
      attempts: delivery.attempts,
    };
  }
  if (outcome.status === "succeeded") {
    return {
      connectionId: delivery.connectionId,
      status: "succeeded",
      attempts: delivery.attempts,
      ...(outcome.url === undefined ? {} : { url: outcome.url }),
    };
  }
  return {
    connectionId: delivery.connectionId,
    status: outcome.status,
    attempts: delivery.attempts,
    ...("reason" in outcome ? { reason: outcome.reason } : {}),
  };
}

function safeOperationErrorCode(error: unknown): string | undefined {
  if (error instanceof ThreadsCiError) {
    return error.code;
  }
  if (!isSyndrooError(error)) {
    return undefined;
  }
  return error.serverError?.code ?? error.code;
}

/** Format a command failure without copying a response body, stack or secret. */
export function safeCliError(error: unknown): {
  readonly exitCode: number;
  readonly body: { readonly status: "error"; readonly code: string; readonly message: string };
} {
  if (error instanceof ThreadsCiError) {
    return {
      exitCode: error.exitCode,
      body: { status: "error", code: error.code, message: error.message },
    };
  }
  if (isSyndrooError(error)) {
    return {
      exitCode: 1,
      body: {
        status: "error",
        code: error.serverError?.code ?? error.code,
        message: error.message,
      },
    };
  }
  return {
    exitCode: 1,
    body: {
      status: "error",
      code: "UNEXPECTED_ERROR",
      message: "The command failed without a safe diagnostic.",
    },
  };
}
