-- Per-writer post reactions: one thumbs up or thumbs down per writer per post,
-- enforced by the composite primary key (switching sides replaces the row).
-- The posts table materializes both counts so the read path stays one query;
-- the previously reserved (always zero) posts.reaction_count becomes up_count.

ALTER TABLE posts RENAME COLUMN reaction_count TO up_count;
ALTER TABLE posts ADD COLUMN down_count INTEGER NOT NULL DEFAULT 0;

-- The composite primary key serves every query (per-post recompute scans and
-- the per-viewer IN lookup both hit its leftmost prefix); no extra index.
CREATE TABLE post_reactions (
  post_id    TEXT NOT NULL,
  reactor_id TEXT NOT NULL,
  reaction   TEXT NOT NULL CHECK (reaction IN ('up', 'down')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, reactor_id)
);
