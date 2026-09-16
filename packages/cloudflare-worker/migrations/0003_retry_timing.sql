-- Strict earliest retry time for a pending retry, as an ISO 8601 UTC timestamp.
-- NULL keeps the previous behavior: the publication has no retry gate and is
-- immediately eligible for claim or Cron selection.
ALTER TABLE publications ADD COLUMN retry_at TEXT;
