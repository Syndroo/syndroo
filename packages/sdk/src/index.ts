/**
 * Public entry point of `@syndroo/sdk`.
 *
 * The SDK is a standalone HTTP client for a deployed Syndroo instance: connect
 * a provider, prepare/execute/status a publish, and wait for a round to finish.
 * It imports no Core and no Provider code, at build time or at runtime.
 */

export { Syndroo } from "./client.js";

export {
  SyndrooError,
  isSyndrooError,
  type SyndrooErrorCode,
  type SyndrooErrorInit,
} from "./errors.js";

export { LIMITS, isLoopbackHostname, type TransportConfig } from "./http.js";

export {
  WAIT_LIMITS,
  defaultSleep,
  isExecutionRoundComplete,
  waitForExecutionRound,
  type WaitDependencies,
  type WaitResult,
} from "./wait.js";

export type {
  ConnectRequest,
  ConnectResult,
  ConnectionView,
  Content,
  DeliveryResult,
  DoneConnectRequest,
  DoneConnectResult,
  Envelope,
  ExecuteRequest,
  ExecutionResult,
  ExecutionStatus,
  FetchLike,
  Json,
  JsonObject,
  NotStarted,
  OperationSummary,
  OperationView,
  PostDocument,
  PrepareOrRetryRequest,
  PreparedResult,
  PrepareRequest,
  ProviderFailureReason,
  ProviderView,
  ProviderWriteOutcome,
  PublishRequest,
  PublishResult,
  RequestOptions,
  RetryRequest,
  SafeError,
  SleepLike,
  StatusRequest,
  StatusResult,
  StatusResultFor,
  SyndrooOptions,
  TargetInput,
  TargetPreview,
  WaitOptions,
  WireOperation,
  ConnectedWriteRequest,
} from "./types.js";
