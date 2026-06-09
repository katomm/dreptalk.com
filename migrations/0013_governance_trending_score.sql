-- Materialized trending sort key for the governance-actions list, refreshed by the
-- gov-sync cron. Ordering rows by trending_score DESC reproduces the in-memory
-- trending order exactly: the recency decay 0.5^((now - last_post_at)/H) factors into
-- 2^(-now/H) * 2^(last_post_at/H), and the 2^(-now/H) term is common to every row at a
-- given render, so it cancels in comparisons. Storing the now-free remainder (in log
-- space, so 2^(last_post_at/H) cannot overflow) lets the list be ordered and paged in
-- the database instead of after loading every row. Nullable until the cron's first
-- refresh backfills it; NULLs sort last under DESC.
ALTER TABLE governance_actions ADD COLUMN trending_score REAL;

-- Serves the default (trending) sort and its tiebreakers as an index-only ordering
-- (trending_score DESC, then submitted_epoch DESC, then topic_id), matching the page's
-- ORDER BY so the hot path is O(page size), not O(all actions).
CREATE INDEX IF NOT EXISTS idx_governance_actions_trending
  ON governance_actions(trending_score DESC, submitted_epoch DESC, topic_id);
