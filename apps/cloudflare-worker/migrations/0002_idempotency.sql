ALTER TABLE posts ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_posts_idempotency_key
  ON posts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
