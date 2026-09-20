-- Per-platform credential storage for agent-guided authentication.
-- Credentials stored here take precedence over environment variables.
CREATE TABLE credentials (
  platform    TEXT NOT NULL PRIMARY KEY,
  data        TEXT NOT NULL,  -- JSON object with platform-specific credential fields
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Temporary state for OAuth 1.0a / 2.0 flows.
-- Rows are deleted once the callback completes or expires.
CREATE TABLE oauth_state (
  state         TEXT NOT NULL PRIMARY KEY,
  platform      TEXT NOT NULL,
  request_token TEXT,  -- OAuth 1.0a only; NULL for OAuth 2.0
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_oauth_state_created_at ON oauth_state(created_at);
