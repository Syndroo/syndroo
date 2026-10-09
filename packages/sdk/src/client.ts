/**
 * `Syndroo` — the public HTTP client of `@syndroo/sdk`.
 *
 * The client is a thin wrapper over the three `/v1` protocol operations plus a
 * status-only `wait`. It mirrors the Core request/result generics from the
 * shared blueprint, adds no server features, and never invents a result the
 * server did not report.
 *
 * What the client deliberately does not do:
 *
 * - it never approves, confirms or resumes anything on its own;
 * - it never retries a business result (`failed`, `partial`, `unknown` are
 *   protocol successes);
 * - it never decides whether a caller-supplied idempotency key is "the same
 *   intent" across two separate calls.
 */

import { SyndrooError } from "./errors.js";
import { HttpTransport, assertIdempotencyKey, resolveTransportOptions } from "./http.js";
import type { TransportRequest } from "./http.js";
import type { WireName } from "./generated/validators.js";
import type { WireOperation } from "./types.js";
import { defaultSleep, waitForExecutionRound } from "./wait.js";
import type {
  ConnectRequest,
  ConnectResult,
  DoneConnectResult,
  DoneConnectRequest,
  ExecuteRequest,
  ExecutionResult,
  FetchLike,
  PrepareOrRetryRequest,
  PublishRequest,
  PublishResult,
  RequestOptions,
  SleepLike,
  StatusRequest,
  StatusResultFor,
  SyndrooOptions,
  WaitOptions,
} from "./types.js";

export class Syndroo {
  private readonly transport: HttpTransport;
  private readonly sleep: SleepLike;

  constructor(options: SyndrooOptions) {
    if (options === null || typeof options !== "object") {
      throw new SyndrooError("INVALID_ARGUMENT");
    }
    const fetchImpl = options.fetch ?? defaultFetch();
    if (typeof fetchImpl !== "function") {
      throw new SyndrooError("INVALID_ARGUMENT");
    }
    const sleepImpl = options.sleep ?? defaultSleep;
    if (typeof sleepImpl !== "function") {
      throw new SyndrooError("INVALID_ARGUMENT");
    }
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fetch: fetchImpl,
    });
    this.sleep = sleepImpl;
  }

  /** Update/disconnect always end in a bound connection. */
  async connect(request: DoneConnectRequest, options?: RequestOptions): Promise<DoneConnectResult>;
  /** Start/resume return whichever connect step the server reports, `start` included. */
  async connect(request: ConnectRequest, options?: RequestOptions): Promise<ConnectResult>;
  async connect(request: ConnectRequest, options: RequestOptions = {}): Promise<ConnectResult> {
    const result = (await this.call("connect", "ConnectRequest", request, options)) as ConnectResult;
    if ((request.type === "update" || request.type === "disconnect") && result.status !== "done") {
      throw new SyndrooError("INVALID_RESPONSE");
    }
    return result;
  }

  /** `execute` always reports an execution round. */
  async publish(request: ExecuteRequest, options?: RequestOptions): Promise<ExecutionResult>;
  /** `prepare`/`retry` may replay an already admitted execution. */
  async publish(request: PrepareOrRetryRequest, options?: RequestOptions): Promise<PublishResult>;
  async publish(request: PublishRequest, options?: RequestOptions): Promise<PublishResult>;
  async publish(request: PublishRequest, options: RequestOptions = {}): Promise<PublishResult> {
    const result = (await this.call("publish", "PublishRequest", request, options)) as PublishResult;
    if (request.type === "execute" && !isExecutionResult(result)) {
      throw new SyndrooError("INVALID_RESPONSE");
    }
    return result;
  }

  /** Return the exact result type of the query that was asked for. */
  async status<T extends StatusRequest>(
    request: T,
    options: RequestOptions = {},
  ): Promise<StatusResultFor<T>> {
    const result = (await this.call("status", "StatusRequest", request, options)) as {
      type?: unknown;
    };
    if (result === null || typeof result !== "object" || result.type !== request.type) {
      throw new SyndrooError("INVALID_RESPONSE");
    }
    return result as StatusResultFor<T>;
  }

  /** Poll `status({ type: "operation" })` until the execution round completes. */
  async wait(operationId: string, options: WaitOptions = {}): Promise<ExecutionResult> {
    return waitForExecutionRound(
      {
        readOperation: async (id, signal) => {
          const result = await this.status(
            { type: "operation", operationId: id },
            signal === undefined ? {} : { signal },
          );
          return result.operation;
        },
        sleep: this.sleep,
      },
      operationId,
      options,
    );
  }

  private async call(
    operation: WireOperation,
    wireName: WireName,
    body: unknown,
    options: RequestOptions,
  ): Promise<unknown> {
    const { timeoutMs, transportRetries } = resolveTransportOptions(options);
    const idempotencyKey = resolveIdempotencyKey(operation, body, options.idempotencyKey);
    const request: TransportRequest = {
      operation,
      wireName,
      body,
      timeoutMs,
      transportRetries,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    return this.transport.send(request);
  }
}

function defaultFetch(): FetchLike {
  const impl = globalThis.fetch;
  if (typeof impl !== "function") {
    throw new SyndrooError("INVALID_ARGUMENT");
  }
  return (input, init) => impl(input, init);
}

function readType(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  return (body as { type?: unknown }).type;
}

/**
 * True when a call carries a write side effect and therefore needs request
 * identity. `resume` is excluded on purpose: it is protected by the connect
 * session id plus step revision, and `execute` is protected by the approval
 * token's admission record.
 */
function needsRequestIdentity(operation: WireOperation, body: unknown): boolean {
  const type = readType(body);
  if (operation === "connect") {
    return type === "start" || type === "update" || type === "disconnect";
  }
  if (operation === "publish") {
    return type === "prepare" || type === "retry";
  }
  return false;
}

/**
 * One key per logical call. A caller-supplied key is validated and reused
 * verbatim; the SDK only mints a key for the calls that require request
 * identity. The key is resolved before the first attempt, so every transport
 * retry of the call sends the same value.
 */
function resolveIdempotencyKey(
  operation: WireOperation,
  body: unknown,
  provided: string | undefined,
): string | undefined {
  if (provided !== undefined) {
    return assertIdempotencyKey(provided);
  }
  return needsRequestIdentity(operation, body) ? generateIdempotencyKey() : undefined;
}

function generateIdempotencyKey(): string {
  const cryptoImpl = globalThis.crypto;
  if (typeof cryptoImpl?.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }
  if (typeof cryptoImpl?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoImpl.getRandomValues(bytes);
    let key = "";
    for (const byte of bytes) {
      key += byte.toString(16).padStart(2, "0");
    }
    return key;
  }
  throw new SyndrooError("INVALID_ARGUMENT");
}

function isExecutionResult(result: PublishResult): result is ExecutionResult {
  return (result as { phase?: unknown }).phase === "execution";
}
