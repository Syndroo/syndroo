/**
 * Row decoders for the 0.5.0 D1 schema.
 *
 * Plain mapping only: no SQL, no statements and no D1 types leak through these
 * functions. Every JSON column is decoded defensively and a corrupt value
 * becomes a safe default rather than an exception carrying raw text.
 */

import type { Platform, PostStatus, PublicationStatus, PublishErrorCode } from "@syndroo/core";
import type {
  ArchiveStatus,
  AuthPhase,
  CipherPurpose,
  CommittedOutcomeIdentity,
  CompleteReceiptRecord,
  EncryptedCredential,
  EncryptedSlotSnapshot,
  ExecutionSnapshot,
  IdempotentPostRecord,
  OutboxJob,
  OutboxJobStatus,
  PostSnapshot,
  PublicationSnapshot,
  PublicationSummary,
  RefreshLease,
  RefreshState,
  SafeTarget,
  SlotStatus,
  StoredAuthOperation,
  TerminalReason,
  TransportReason,
} from "@syndroo/application";
import { CorruptStoreRecordError } from "@syndroo/application";

export interface PostRow {
  readonly id: string;
  readonly content: string;
  readonly platforms: string;
  readonly overrides: string | null;
  readonly scheduled_at: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly idempotency_key: string | null;
  readonly request_fingerprint: string | null;
}

export interface PublicationRow {
  readonly id: string;
  readonly post_id: string;
  readonly platform: string;
  readonly provider: string;
  readonly content: string;
  readonly status: string;
  readonly attempts: number;
  readonly external_id: string | null;
  readonly external_url: string | null;
  readonly error_code: string | null;
  readonly error_ambiguous: number;
  readonly retry_at: string | null;
  readonly publishing_at: string | null;
  readonly published_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly credential_binding: string | null;
  readonly credential_revision_at_create: number | null;
  readonly claim_token: string | null;
  readonly attempt_id: string | null;
  readonly current_job_id: string | null;
  readonly terminal_reason: string | null;
  readonly archive_key: string | null;
  readonly archive_status: string | null;
  readonly committed_outcome_key: string | null;
  readonly committed_outcome_fingerprint: string | null;
}

export interface OutboxJobRow {
  readonly id: string;
  readonly kind: string;
  readonly payload_version: number;
  readonly aggregate_id: string;
  readonly attempt_no: number;
  readonly available_at: string;
  readonly status: string;
  readonly dispatch_revision: number;
  readonly dispatch_attempt_count: number;
  readonly last_dispatch_error_code: string | null;
  readonly dispatched_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly recovery_count: number;
  readonly recovery_after: string | null;
  readonly dlq_seen_at: string | null;
  readonly transport_reason: string | null;
}

export interface CredentialRow {
  readonly platform: string;
  readonly data: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
  readonly revision: number;
  readonly binding_id: string | null;
  readonly tombstone: number;
  readonly payload_revision: number | null;
  readonly payload_schema_version: number | null;
  readonly envelope: string | null;
  readonly target_label: string | null;
  readonly target_source: string | null;
  readonly refresh_state: string | null;
  readonly refresh_lease_token: string | null;
  readonly refresh_lease_acquired_at: string | null;
  readonly refresh_lease_expires_at: string | null;
  readonly refresh_lease_revision: number | null;
  readonly last_refresh_commit_fingerprint: string | null;
}

export interface OAuthOperationRow {
  readonly operation_id: string;
  readonly platform: string;
  readonly state: string;
  readonly phase: string | null;
  readonly expected_revision: number | null;
  readonly canonical_callback_url: string | null;
  readonly start_config_binding: string | null;
  readonly request_token: string | null;
  readonly request_secret_envelope: string | null;
  readonly request_secret_purpose: string | null;
  readonly request_secret_revision: number | null;
  readonly candidate_envelope: string | null;
  readonly candidate_payload_revision: number | null;
  readonly candidate_payload_schema_version: number | null;
  readonly candidate_target_label: string | null;
  readonly candidate_target_source: string | null;
  readonly receipt: string | null;
  readonly missing_fields: string | null;
  readonly error_code: string | null;
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string | null;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function decodeEnvelope(value: string | null): EncryptedCredential | null {
  if (value === null || value.length === 0) {
    return null;
  }
  const parsed = parseJson<EncryptedCredential | null>(value, null);
  if (
    parsed === null ||
    parsed.version !== 1 ||
    parsed.algorithm !== "AES-256-GCM" ||
    typeof parsed.keyId !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    // A nonempty but malformed envelope is corruption, not an absent slot: it
    // must never fall back to Env or stale plaintext.
    throw new CorruptStoreRecordError("stored credential envelope is malformed");
  }
  return Object.freeze({ ...parsed });
}

function hasLegacyPlaintext(data: string): boolean {
  if (data.length === 0) {
    return false;
  }
  const parsed = parseJson<Record<string, unknown> | null>(data, null);
  if (parsed === null) {
    return true;
  }
  return Object.keys(parsed).length > 0;
}

export function toPostSnapshot(row: PostRow): PostSnapshot {
  return Object.freeze({
    id: row.id,
    status: row.status as PostStatus,
    content: row.content,
    platforms: Object.freeze(parseJson<Platform[]>(row.platforms, [])),
    overrides: Object.freeze(
      parseJson<Record<string, { content?: string }>>(row.overrides, {}),
    ),
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function toPublicationSnapshot(row: PublicationRow): PublicationSnapshot {
  const committedOutcome: CommittedOutcomeIdentity | null =
    row.committed_outcome_key === null || row.committed_outcome_fingerprint === null
      ? null
      : Object.freeze({
          key: row.committed_outcome_key,
          fingerprint: row.committed_outcome_fingerprint,
        });
  return Object.freeze({
    id: row.id,
    postId: row.post_id,
    platform: row.platform as Platform,
    provider: row.provider,
    content: row.content,
    status: row.status as PublicationStatus,
    attempts: row.attempts,
    claimToken: row.claim_token,
    attemptId: row.attempt_id,
    currentJobId: row.current_job_id,
    retryAt: row.retry_at,
    publishingAt: row.publishing_at,
    publishedAt: row.published_at,
    credentialBinding: row.credential_binding,
    credentialRevisionAtCreate: row.credential_revision_at_create,
    terminalReason: (row.terminal_reason as TerminalReason | null) ?? null,
    errorCode: (row.error_code as PublishErrorCode | null) ?? null,
    errorAmbiguous: row.error_ambiguous === 1,
    externalId: row.external_id,
    externalUrl: row.external_url,
    archiveKey: row.archive_key,
    archiveStatus: (row.archive_status as ArchiveStatus | null) ?? "not_requested",
    committedOutcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function toPublicationSummary(row: PublicationRow): PublicationSummary {
  return Object.freeze({
    publicationId: row.id,
    platform: row.platform as Platform,
    status: row.status as PublicationStatus,
    externalId: row.external_id,
    externalUrl: row.external_url,
    errorCode: (row.error_code as PublishErrorCode | null) ?? null,
    errorAmbiguous: row.error_ambiguous === 1,
    terminalReason: (row.terminal_reason as TerminalReason | null) ?? null,
  });
}

export function toOutboxJob(row: OutboxJobRow): OutboxJob {
  if (row.kind !== "delivery.execute" || row.payload_version !== 1) {
    // Unknown persisted protocols are never coerced into the current one.
    throw new CorruptStoreRecordError("unsupported persisted job protocol");
  }
  return Object.freeze({
    id: row.id,
    kind: "delivery.execute",
    payloadVersion: 1,
    aggregateId: row.aggregate_id,
    attemptNo: row.attempt_no,
    availableAt: row.available_at,
    status: row.status as OutboxJobStatus,
    dispatchRevision: row.dispatch_revision,
    dispatchAttemptCount: row.dispatch_attempt_count,
    lastDispatchErrorCode: row.last_dispatch_error_code,
    dispatchedAt: row.dispatched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recoveryCount: row.recovery_count,
    recoveryAfter: row.recovery_after,
    dlqSeenAt: row.dlq_seen_at,
    transportReason: (row.transport_reason as TransportReason | null) ?? null,
  });
}

export function toExecutionSnapshot(
  publication: PublicationRow,
  post: PostRow,
  job: OutboxJobRow,
): ExecutionSnapshot {
  return Object.freeze({
    publication: toPublicationSnapshot(publication),
    post: toPostSnapshot(post),
    job: toOutboxJob(job),
  });
}

export function toIdempotentRecord(
  post: PostRow,
  publications: readonly PublicationRow[],
  jobIds: readonly string[],
): IdempotentPostRecord {
  return Object.freeze({
    scope: "posts.create.v1" as const,
    key: post.idempotency_key,
    requestFingerprint: post.request_fingerprint ?? "",
    post: toPostSnapshot(post),
    publications: Object.freeze(publications.map(toPublicationSummary)),
    jobIds: Object.freeze([...jobIds]),
    createdAt: post.created_at,
  });
}

function decodeTarget(row: CredentialRow): SafeTarget | null {
  if (row.target_label === null || row.target_source === null) {
    return null;
  }
  if (row.target_source !== "user" && row.target_source !== "provider") {
    return null;
  }
  return Object.freeze({ label: row.target_label, source: row.target_source });
}

function decodeLease(row: CredentialRow): RefreshLease | null {
  if (
    row.refresh_lease_token === null ||
    row.refresh_lease_acquired_at === null ||
    row.refresh_lease_expires_at === null ||
    row.refresh_lease_revision === null
  ) {
    return null;
  }
  return Object.freeze({
    token: row.refresh_lease_token,
    acquiredAt: row.refresh_lease_acquired_at,
    expiresAt: row.refresh_lease_expires_at,
    revision: row.refresh_lease_revision,
  });
}

export function toSlotSnapshot(
  row: CredentialRow | null,
  platform: Platform,
): EncryptedSlotSnapshot {
  if (row === null) {
    return Object.freeze({
      platform,
      status: "empty" as SlotStatus,
      revision: 0,
      bindingId: null,
      envelope: null,
      payloadRevision: null,
      payloadSchemaVersion: null,
      expiresAt: null,
      target: null,
      refreshLease: null,
      refreshState: "ready" as RefreshState,
      lastRefreshCommitFingerprint: null,
      updatedAt: null,
    });
  }
  const envelope = decodeEnvelope(row.envelope);
  if (envelope === null && row.tombstone === 0 && hasLegacyPlaintext(row.data)) {
    // Unmigrated plaintext in an active slot: explicit migration must clear it,
    // and publishing must not silently read it.
    throw new CorruptStoreRecordError("credential slot requires explicit migration");
  }
  const status: SlotStatus =
    row.tombstone === 1 ? "tombstone" : envelope === null ? "empty" : "active";
  return Object.freeze({
    platform,
    status,
    revision: row.revision,
    bindingId: row.binding_id,
    envelope,
    payloadRevision: row.payload_revision,
    payloadSchemaVersion: row.payload_schema_version,
    expiresAt: row.expires_at,
    target: decodeTarget(row),
    refreshLease: decodeLease(row),
    refreshState: row.refresh_state === "reconnect_required" ? "reconnect_required" : "ready",
    lastRefreshCommitFingerprint: row.last_refresh_commit_fingerprint,
    updatedAt: row.updated_at,
  });
}

export function toStoredAuthOperation(row: OAuthOperationRow): StoredAuthOperation {
  const receipt = parseJson<CompleteReceiptRecord | null>(row.receipt, null);
  const candidateTarget =
    row.candidate_target_label !== null &&
    (row.candidate_target_source === "user" || row.candidate_target_source === "provider")
      ? Object.freeze({
          label: row.candidate_target_label,
          source: row.candidate_target_source,
        })
      : null;
  return Object.freeze({
    operationId: row.operation_id,
    platform: row.platform as Platform,
    phase: (row.phase as AuthPhase | null) ?? "pending_callback",
    expectedRevision: row.expected_revision ?? 0,
    canonicalCallbackUrl: row.canonical_callback_url ?? "",
    startConfigBinding: row.start_config_binding ?? "",
    oauthState: row.state,
    requestToken: row.request_token,
    requestSecret: decodeEnvelope(row.request_secret_envelope),
    requestSecretPurpose: (row.request_secret_purpose as CipherPurpose | null) ?? null,
    requestSecretRevision: row.request_secret_revision,
    candidateEnvelope: decodeEnvelope(row.candidate_envelope),
    candidatePayloadRevision: row.candidate_payload_revision,
    candidatePayloadSchemaVersion: row.candidate_payload_schema_version,
    candidateTarget,
    receipt,
    missingFields: Object.freeze(parseJson<string[]>(row.missing_fields, [])),
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    expiresAt: row.expires_at,
  });
}
