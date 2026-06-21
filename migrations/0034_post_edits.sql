-- migrations/0034_post_edits.sql
-- Post editing history. The live `posts` row always holds the current body; each
-- version superseded after the grace window is archived here (one row per
-- superseded version). posts.edited_at (added in 0002) marks an edited post.
CREATE TABLE IF NOT EXISTS post_revisions (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  replaced_at INTEGER NOT NULL,
  editor_id   TEXT NOT NULL
);
-- History reads fetch one post's revisions newest-first.
CREATE INDEX IF NOT EXISTS idx_post_revisions_post ON post_revisions(post_id, replaced_at);

-- Title edits keep only a marker (no stored prior titles); full history is for bodies.
ALTER TABLE topics ADD COLUMN title_edited_at INTEGER;
