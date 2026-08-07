-- Materialized per-badge holder count, so profile pages and the /badges
-- overview no longer aggregate the full badge_awards table on every render.
-- Refreshed by the hourly badges cron right after new awards are written,
-- which is the only path that changes the counts.
CREATE TABLE IF NOT EXISTS badge_holder_counts (
  badge_id   TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
