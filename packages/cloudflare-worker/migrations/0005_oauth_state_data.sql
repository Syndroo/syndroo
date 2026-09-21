-- Replace the oauth_state table with a corrected schema.
-- Changes:
--   request_token TEXT  → data TEXT NOT NULL DEFAULT '{}'
--     OAuth 1.0a stores {"request_token":"…","request_token_secret":"…"} here;
--     the previous column stored only the public token, which caused an
--     incorrect signing key (token used as secret) in the access-token exchange.
--   Add expires_at TEXT NOT NULL for automatic stale-row detection.
--
-- Drop-and-recreate is safe because:
--   (a) oauth_state rows are transient; any in-flight rows expire in minutes.
--   (b) This is a release candidate with no production deployment.
DROP TABLE oauth_state;

CREATE TABLE oauth_state (
  state      TEXT NOT NULL PRIMARY KEY,
  platform   TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_state_expires_at ON oauth_state(expires_at);

-- Add first-class expires_at column to credentials for quick token-expiry
-- checks without JSON parsing.  NULL = token does not expire (OAuth 1.0a).
ALTER TABLE credentials ADD COLUMN expires_at TEXT;
