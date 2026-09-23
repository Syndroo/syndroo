-- 0.5.0 portable execution schema.
--
-- Additive only: migrations 0001-0005 are immutable. Existing posts,
-- publications, credentials and oauth_state rows keep their IDs, content,
-- canonical request intent and idempotency keys. Nothing here creates an
-- executable job: the reviewed cutover tool owns any backfill.
--
-- `mutation_marker` is a private per-invocation token written only by the
-- winning conditional statement of a batch. Dependent statements of the same
-- batch match that exact token, so a zero-row guard can never authorise a
-- sibling write in SQLite/D1, where an ordinary UPDATE affecting zero rows does
-- not roll back the rest of the batch.

ALTER TABLE posts ADD COLUMN mutation_marker TEXT;
-- Canonical create-request fingerprint (opaque equality token supplied by the
-- application); used to replay the original receipt without re-deriving intent.
ALTER TABLE posts ADD COLUMN request_fingerprint TEXT;

ALTER TABLE publications ADD COLUMN mutation_marker TEXT;
ALTER TABLE publications ADD COLUMN credential_binding TEXT;
ALTER TABLE publications ADD COLUMN credential_revision_at_create INTEGER;
ALTER TABLE publications ADD COLUMN claim_token TEXT;
ALTER TABLE publications ADD COLUMN attempt_id TEXT;
ALTER TABLE publications ADD COLUMN current_job_id TEXT;
ALTER TABLE publications ADD COLUMN terminal_reason TEXT;
ALTER TABLE publications ADD COLUMN archive_key TEXT;
ALTER TABLE publications ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE publications ADD COLUMN committed_outcome_key TEXT;
ALTER TABLE publications ADD COLUMN committed_outcome_fingerprint TEXT;

ALTER TABLE credentials ADD COLUMN mutation_marker TEXT;
ALTER TABLE credentials ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credentials ADD COLUMN binding_id TEXT;
ALTER TABLE credentials ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credentials ADD COLUMN payload_revision INTEGER;
ALTER TABLE credentials ADD COLUMN payload_schema_version INTEGER;
ALTER TABLE credentials ADD COLUMN envelope TEXT;
ALTER TABLE credentials ADD COLUMN target_label TEXT;
ALTER TABLE credentials ADD COLUMN target_source TEXT;
ALTER TABLE credentials ADD COLUMN refresh_state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE credentials ADD COLUMN refresh_lease_token TEXT;
ALTER TABLE credentials ADD COLUMN refresh_lease_acquired_at TEXT;
ALTER TABLE credentials ADD COLUMN refresh_lease_expires_at TEXT;
ALTER TABLE credentials ADD COLUMN refresh_lease_revision INTEGER;
ALTER TABLE credentials ADD COLUMN last_refresh_commit_fingerprint TEXT;

CREATE TABLE outbox_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  aggregate_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  available_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'cancelled')),
  dispatch_revision INTEGER NOT NULL DEFAULT 0,
  dispatch_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_dispatch_error_code TEXT,
  dispatched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recovery_count INTEGER NOT NULL DEFAULT 0,
  recovery_after TEXT,
  dlq_seen_at TEXT,
  transport_reason TEXT,
  mutation_marker TEXT,
  UNIQUE (kind, aggregate_id, attempt_no)
);

CREATE INDEX idx_outbox_ready ON outbox_jobs(status, available_at, id);
CREATE INDEX idx_outbox_recovery ON outbox_jobs(status, recovery_after, id);
CREATE INDEX idx_outbox_aggregate ON outbox_jobs(aggregate_id, attempt_no);
CREATE INDEX idx_outbox_dlq_seen ON outbox_jobs(dlq_seen_at, available_at, id);

CREATE INDEX idx_publications_stale_claim ON publications(status, publishing_at, id);
CREATE INDEX idx_publications_retry ON publications(status, retry_at);
CREATE INDEX idx_publications_current_job ON publications(current_job_id);
CREATE INDEX idx_publications_archive ON publications(archive_status, updated_at);

-- OAuth operations reuse the existing transient table additively. Legacy rows
-- keep operation_id/phase NULL and are therefore invisible to the new flow
-- (every new-flow statement requires a matching operation_id).
ALTER TABLE oauth_state ADD COLUMN operation_id TEXT;
ALTER TABLE oauth_state ADD COLUMN request_token TEXT;
ALTER TABLE oauth_state ADD COLUMN phase TEXT;
ALTER TABLE oauth_state ADD COLUMN expected_revision INTEGER;
ALTER TABLE oauth_state ADD COLUMN canonical_callback_url TEXT;
ALTER TABLE oauth_state ADD COLUMN start_config_binding TEXT;
ALTER TABLE oauth_state ADD COLUMN request_secret_envelope TEXT;
ALTER TABLE oauth_state ADD COLUMN request_secret_purpose TEXT;
ALTER TABLE oauth_state ADD COLUMN request_secret_revision INTEGER;
ALTER TABLE oauth_state ADD COLUMN candidate_envelope TEXT;
ALTER TABLE oauth_state ADD COLUMN candidate_payload_revision INTEGER;
ALTER TABLE oauth_state ADD COLUMN candidate_payload_schema_version INTEGER;
ALTER TABLE oauth_state ADD COLUMN candidate_target_label TEXT;
ALTER TABLE oauth_state ADD COLUMN candidate_target_source TEXT;
ALTER TABLE oauth_state ADD COLUMN receipt TEXT;
ALTER TABLE oauth_state ADD COLUMN missing_fields TEXT;
ALTER TABLE oauth_state ADD COLUMN error_code TEXT;
ALTER TABLE oauth_state ADD COLUMN updated_at TEXT;
ALTER TABLE oauth_state ADD COLUMN mutation_marker TEXT;

CREATE UNIQUE INDEX idx_oauth_state_operation_id
  ON oauth_state(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX idx_oauth_state_phase ON oauth_state(phase, expires_at);
CREATE INDEX idx_oauth_state_platform_state ON oauth_state(platform, state);
