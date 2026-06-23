-- Content-addressed store for vote rationale documents (CIP-100). Mirrors
-- drep_metadata: hosting is unauthenticated; authenticity is bound on-chain by
-- the vote anchor hash. INSERT OR IGNORE on the hash means an unauthenticated
-- write can neither overwrite nor clobber another document.
CREATE TABLE vote_rationale (
  hash       TEXT PRIMARY KEY,   -- blake2b-256 of body, 64 hex
  body       TEXT NOT NULL,      -- canonical CIP-100 JSON
  drep_id    TEXT NOT NULL,      -- author (claimed; not trusted)
  ga_id      TEXT NOT NULL,      -- governance action this rationale is for
  created_at INTEGER NOT NULL
);
