-- Community flagging: any on-chain writer can flag a post; the composite primary
-- key enforces one flag per writer per post (dedup). posts.flag_count is the
-- materialized count of distinct flaggers; posts.hidden is set when that count
-- reaches the hide threshold (see src/lib/db/postFlags.ts).
CREATE TABLE IF NOT EXISTS post_flags (
  post_id    TEXT NOT NULL,
  flagger_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, flagger_id)
);
CREATE INDEX IF NOT EXISTS idx_post_flags_post ON post_flags(post_id);

ALTER TABLE posts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
