/**
 * Public types of `@syndroo/sdk`.
 *
 * Wire shapes are re-exported from the generated protocol module rather than
 * copied, so the SDK cannot drift from the canonical schema and the generated
 * artifact stays the single source. Two generated names are deliberately not
 * used as request/response types:
 *
 * - `StatusResultMap` is emitted as one object with five required keys
 *   (`overview`, `provider`, `connections`, `operation`, `operations`) instead
 *   of a type-level mapping. The union `StatusResult` is what a status response
 *   actually carries, so the SDK narrows `StatusResult` with `Extract` below.
 * - `StatusResult` itself carries no query correlation, so `status()` checks the
 *   returned `type` against the requested one at runtime.
 *
 * This module has no Core or Provider imports; it only re-exports generated wire
 * types and declares SDK-level option and helper types.
 */

export type {
  ConnectRequest,
  ConnectResult,
  ConnectionView,
  Content,
  DeliveryResult,
  Envelope,
  ExecutionResult,
  ExecutionStatus,
  Json,
  JsonObject,
  NotStarted,
  OperationSummary,
  OperationView,
  PostDocument,
  PreparedResult,
  PrepareRequest,
  ProviderFailureReason,
  ProviderView,
  ProviderWriteOutcome,
  PublishRequest,
  RetryRequest,
  SafeError,
  StatusRequest,
  StatusResult,
  ExecuteRequest,
  TargetInput,
  TargetPreview,
} from "./generated/types.js";

import type {
  ConnectRequest,
  ConnectResult,
  ExecutionResult,
  PreparedResult,
  PublishRequest,
  StatusRequest,
  StatusResult,
} from "./generated/types.js";

/**
 * The blueprint's `PublishResult`. The generator does not emit the alias, so
 * the SDK declares it from the two generated branches: a publish call either
 * prepared a new intent or replayed an already admitted execution.
 */
export type PublishResult = PreparedResult | ExecutionResult;

/** The three protocol operations, matching the `/v1` routes. */
export type WireOperation = "connect" | "publish" | "status";

/** Injected transport, so tests and embedders never need a real network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injected wait delay, so tests can run without real time passing. */
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

export type SyndrooOptions = {
  /** Origin of a Syndroo server, for example `https://syndroo.example`. */
  baseUrl: string;
  /** Bearer secret of the deployment. Never placed in a URL or an error. */
  apiKey: string;
  /** Defaults to the runtime `fetch`. */
  fetch?: FetchLike;
  /** Defaults to a timer-backed sleep that honours cancellation. */
  sleep?: SleepLike;
};

/**
 * Per-call transport options.
 *
 * These configure transport only. They never change the content being written,
 * never approve anything and never resume a credential step.
 */
export type RequestOptions = {
  /**
   * Stable machine identity of one logical call. Generated once when the
   * operation requires request identity (connect start/update/disconnect and
   * publish prepare/retry) and reused by every transport retry of that call.
   * Supply it yourself to recover the same operation across processes.
   */
  idempotencyKey?: string;
  /** Local cancellation. Stops the call; it never cancels server work. */
  signal?: AbortSignal;
  /** Defaults to 30,000 ms; the protocol maximum is 120,000 ms. */
  timeoutMs?: number;
  /** Transport retries, 0 to 2. Defaults to 0. */
  transportRetries?: number;
};

export type WaitOptions = {
  /** Poll interval, 250 to 30,000 ms. Defaults to 2,000 ms. */
  intervalMs?: number;
  /** Total wait, at most 3,600,000 ms. Defaults to 120,000 ms. */
  timeoutMs?: number;
  /** Local cancellation of the wait only. */
  signal?: AbortSignal;
};

/** A connect call that must end in a bound connection. */
export type DoneConnectResult = Extract<ConnectResult, { status: "done" }>;

/**
 * Connect requests that always answer with a bound connection.
 *
 * Only `update` and `disconnect` are in this set. `start` is deliberately
 * excluded: it can answer `action_required`, so a narrowed `done` overload for
 * `start` would promise a `connection` the server need not send.
 */
export type DoneConnectRequest = Extract<ConnectRequest, { type: "update" | "disconnect" }>;

/** Status result for one concrete query, narrowed by the request's `type`. */
export type StatusResultFor<T extends StatusRequest> = Extract<StatusResult, { type: T["type"] }>;

/** Connect requests with write side effects, which require request identity. */
export type ConnectedWriteRequest = Extract<ConnectRequest, { type: "start" | "update" | "disconnect" }>;

/** Publish requests that require request identity. */
export type PrepareOrRetryRequest = Extract<PublishRequest, { type: "prepare" | "retry" }>;
