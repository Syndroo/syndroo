/**
 * Public entry point of `@syndroo/sdk`.
 *
 * The SDK is a thin HTTP client for a deployed Syndroo instance. It keeps the
 * documented `/v1` contract and adds no server-side behavior.
 */

export {
  DEFAULT_MAX_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  PostsResource,
  SyndrooClient,
  type CreatePostOptions,
  type ListPostsOptions,
  type RequestOptions,
  type SyndrooClientOptions,
  type WaitOptions,
} from "./client.js";

export { AuthResource } from "./auth.js";

export {
  type AuthCompleteInput,
  type AuthCompleteTarget,
  type AuthCredentialInput,
  type AuthMutationOptions,
  type AuthOperationStatus,
  type AuthPhase,
  type AuthRefreshReceipt,
  type AuthRemoveReceipt,
  type AuthRequestOptions,
  type AuthSetReceipt,
  type AuthSource,
  type AuthStatus,
  type CompleteReceipt,
  type ConnectReceipt,
  type InstanceStatus,
  type PlatformStatus,
  type PlatformTarget,
  type Readiness,
} from "./auth-types.js";

export { type Diagnostics, type DiagnosticsStorage } from "./diagnostics.js";

export {
  SyndrooAbortError,
  SyndrooApiError,
  SyndrooConfigError,
  SyndrooError,
  SyndrooNetworkError,
  SyndrooResponseError,
  SyndrooTimeoutError,
  SyndrooValidationError,
  SyndrooWaitTimeoutError,
  isSyndrooError,
  type SdkOperation,
  type SyndrooErrorCode,
  type SyndrooErrorInit,
} from "./errors.js";

export {
  isPostDelivered,
  isPostTerminal,
  type CreatePostInput,
  type HealthStatus,
  type KnownPlatform,
  type Platform,
  type PostDetail,
  type PostOverride,
  type PostReceipt,
  type PostStatus,
  type PostSummary,
  type Publication,
  type PublicationStatus,
  type PublishErrorCode,
  type SupportsFutureValues,
} from "./types.js";
