PRAGMA foreign_keys = ON;

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  platforms TEXT NOT NULL,
  overrides TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('scheduled', 'queued', 'publishing', 'published', 'partial', 'failed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  provider TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('scheduled', 'pending', 'publishing', 'published', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  external_id TEXT,
  external_url TEXT,
  error_code TEXT,
  error_message TEXT,
  error_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (error_ambiguous IN (0, 1)),
  enqueued_at TEXT,
  publishing_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  UNIQUE (post_id, platform)
);

CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_scheduled_at ON posts(status, scheduled_at);
CREATE INDEX idx_publications_post_id ON publications(post_id);
CREATE INDEX idx_publications_status ON publications(status);
CREATE INDEX idx_publications_enqueue
  ON publications(status, enqueued_at, post_id);
