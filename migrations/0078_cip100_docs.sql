-- migrations/0078_cip100_docs.sql
-- Content-addressed store for emitted CIP-100 discussion documents. Mirrors
-- vote_rationale: the hash is the primary key, so a repeated emit of identical
-- bytes can never clobber an existing document. body is NULLed on erasure,
-- which is what distinguishes a tombstoned document (410) from an unknown
-- one (404).
CREATE TABLE cip100_docs (
  hash             TEXT PRIMARY KEY,   -- blake2b-256 of body, 64 hex
  body             TEXT,               -- exact served bytes, NULL once purged
  post_id          TEXT NOT NULL,
  topic_id         TEXT NOT NULL,
  version          INTEGER NOT NULL,   -- position in this post's document chain
  prev_hash        TEXT,               -- previous version's hash, NULL for version 1
  source_edited_at INTEGER,            -- posts.edited_at this document was reconciled against
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER,            -- set when the bytes were purged
  -- Without this, two concurrent edits both write version 2 with the same
  -- prev_hash and the chain forks, which makes the version index's linear
  -- history a lie. The loser rebuilds against the new head instead.
  UNIQUE (post_id, version)
);
CREATE INDEX idx_cip100_docs_post ON cip100_docs(post_id, version);
CREATE INDEX idx_cip100_docs_topic ON cip100_docs(topic_id, created_at);

-- Drives the purge sweep without scanning the whole posts table.
CREATE INDEX idx_posts_deleted ON posts(id) WHERE deleted = 1;

-- Deletion timestamps, so a tombstone can carry deletedAt the moment the flag
-- is set rather than only after the purge sweep has run. Nullable: rows deleted
-- before this migration have no known timestamp.
ALTER TABLE posts ADD COLUMN deleted_at INTEGER;
ALTER TABLE topics ADD COLUMN deleted_at INTEGER;
