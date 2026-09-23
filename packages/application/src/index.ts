/**
 * Public surface of the private `@syndroo/application` package: the frozen
 * runtime-neutral contracts and ports plus the portable use cases that compose
 * them (publishing, preparation, direct credentials and OAuth).
 *
 * No Cloudflare, Node, provider or framework imports, and no ambient types
 * beyond standard ES/DOM/WebCrypto. Test doubles stay on the separate
 * `./testing` subpath and are never re-exported here.
 */

export * from "./contracts/primitives.js";
export * from "./contracts/binding.js";
export * from "./contracts/status.js";
export * from "./contracts/idempotency.js";
export * from "./contracts/outbox.js";
export * from "./contracts/execution.js";
export * from "./contracts/credentials.js";
export * from "./contracts/storage.js";

export type { PublishingStore, IdempotencyLookup, ExecutionLookup } from "./ports/publishing-store.js";
export type { OutboxStore } from "./ports/outbox-store.js";
export type {
  CredentialStore,
  SlotLookup,
  AuthOperationLookup,
  AuthOperationStateLookup,
} from "./ports/credential-store.js";
export { JobQueueError, type JobQueue, type QueueSendCertainty } from "./ports/job-queue.js";
export type { ArchiveStore } from "./ports/archive-store.js";
export type { BlobStore } from "./ports/blob-store.js";
export {
  assertEncryptedEnvelopeShape,
  assertProductionCipher,
  CipherUnavailableError,
  type CredentialCipher,
  type CredentialCipherKind,
} from "./ports/credential-cipher.js";
export type { Logger } from "./ports/logger.js";
export type { DiagnosticsReader } from "./ports/diagnostics-reader.js";
export {
  emptyPlatformConfig,
  type PlatformConfigView,
  type PlatformStrategyRegistry,
  type PreparedPublisher,
  type PublisherBlockReason,
  type PublisherPreparation,
  type PublisherPrepareInput,
  type PublisherStrategy,
} from "./ports/publisher-strategy.js";

// ---------------------------------------------------------------------------
// 0.5.0 credential, OAuth and preparation use cases
//
// Explicit additive exports: only the accepted APIs and their types, and never
// the two same-named `ACTIVE_SLOT_PAYLOAD_SCHEMA_VERSION` constants that complete
// and refresh each keep private to their own module.
// ---------------------------------------------------------------------------

export {
  AuthUseCaseError,
  authFailure,
  preserveAuthFailure,
  safeReadiness,
  type AuthErrorCode,
  type AuthErrorReason,
} from "./use-cases/auth-errors.js";
export {
  createPreparePublisher,
  preparePublisher,
  readTrustedSlot,
  type PreparePublisher,
  type PreparePublisherDependencies,
} from "./use-cases/prepare-publisher.js";
export {
  nextPayloadRevision,
  projectStatus,
  removeDirectCredential,
  setDirectCredential,
  type DirectCredentialDecode,
  type DirectCredentialDecoder,
  type DirectCredentialDependencies,
  type RemoveCredentialInput,
  type SetDirectCredentialInput,
} from "./use-cases/direct-credentials.js";
export {
  decodeOAuthCandidate,
  encodeOAuthCandidate,
  MAX_OAUTH_CANDIDATE_BYTES,
  OAUTH_CANDIDATE_VERSION,
  type OAuthCandidateDecodeResult,
  type OAuthCandidateEncodeResult,
  type OAuthCandidateFailureReason,
  type OAuthCandidatePayload,
} from "./use-cases/oauth-candidate.js";
export {
  OAuthDriverError,
  OAUTH_CANDIDATE_FIELDS,
  preserveDriverFailure,
  safeMissingFields,
  storedErrorCodeFor,
  type OAuthBeginInput,
  type OAuthBeginResult,
  type OAuthCallbackSnapshot,
  type OAuthConfirmInput,
  type OAuthConfirmResult,
  type OAuthDriver,
  type OAuthDriverFailureReason,
  type OAuthDriverResolver,
  type OAuthDriverSnapshot,
  type OAuthExchangeInput,
  type OAuthExchangeResult,
  type OAuthProtocol,
  type OAuthRefreshInput,
  type OAuthRefreshResult,
  type OAuthStoredErrorCode,
  type OAuthTargetOverrides,
} from "./use-cases/oauth-driver.js";
export {
  beginOAuthConnect,
  requireDriverSnapshot,
  OAUTH_REQUEST_SECRET_GENERATION,
  type OAuthConnectDependencies,
  type OAuthConnectInput,
  type OAuthConnectReceipt,
  type OAuthIdFactory,
  type OAuthIdKind,
} from "./use-cases/oauth-connect.js";
export {
  completeOAuthCallback,
  type OAuthCallbackDependencies,
  type OAuthCallbackInput,
  type OAuthCallbackOutcome,
} from "./use-cases/oauth-callback.js";
export {
  readAuthOperationProjection,
  type AuthOperationReadDependencies,
  type AuthOperationReadInput,
} from "./use-cases/auth-operation.js";
export {
  completeOAuthOperation,
  type CompleteOAuthOperationDependencies,
  type CompleteOAuthOperationInput,
} from "./use-cases/oauth-complete.js";
export {
  refreshOAuthCredential,
  MAX_REFRESHED_PLAINTEXT_BYTES,
  type RefreshOAuthCredentialDependencies,
  type RefreshOAuthCredentialInput,
} from "./use-cases/oauth-refresh.js";
export {
  requireRefreshDriverSnapshot,
  type OAuthRefreshDriver,
  type OAuthRefreshDriverResolver,
} from "./use-cases/oauth-refresh-driver.js";
export {
  MAX_CONTENT_CODE_POINTS,
  MAX_DISPATCH_JOBS_PER_TICK,
  PublishingUseCaseError,
  createUseCaseId,
  readClockNow,
  snapshotCreateInput,
  snapshotIdempotencyKey,
  type NormalizedCreateInput,
  type PublishingErrorCode,
  type PublishingErrorReason,
  type UseCaseClock,
  type UseCaseIdFactory,
  type UseCaseIdKind,
} from "./use-cases/shared.js";
export {
  createPost,
  type CreatePostDependencies,
  type CreatePostResult,
} from "./use-cases/create-post.js";
export {
  EMPTY_DISPATCH_REPORT,
  dispatchReadyJobs,
  dispatchReportDeferred,
  type DispatchReadyJobsInput,
  type DispatchReport,
  type DispatchSendFailureCode,
} from "./use-cases/dispatch-ready-jobs.js";
export {
  executePublication,
  type ExecutePublicationDependencies,
} from "./use-cases/execute-publication.js";
export {
  settleDeadLetterMessage,
  type DlqConsumerOutcome,
  type DlqQuarantineReason,
  type SettleDeadLetterDependencies,
} from "./use-cases/settle-dead-letter.js";
export {
  runMaintenance,
  type DispatchPhaseReport,
  type ExpiredCleanupPhaseReport,
  type FinishedCollectionPhaseReport,
  type MaintenanceLimits,
  type MaintenancePhase,
  type MaintenancePhaseCode,
  type MaintenancePhaseStatus,
  type MaintenanceReport,
  type RecoveryPhaseReport,
  type RunMaintenanceDependencies,
} from "./use-cases/run-maintenance.js";
