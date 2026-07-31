-- Audit/dedup record for InfoAction CIP-108 metadata pinned to IPFS. Not the
-- anchor: the anchor is ipfs://<cid>. Keyed by the blake2b-256 anchor hash, so
-- INSERT OR IGNORE means resubmitting identical content skips the re-upload
-- and never overwrites an existing row (mirrors vote_rationale/drep_metadata).
CREATE TABLE gov_action_metadata (
  hash       TEXT PRIMARY KEY,   -- blake2b-256 of body, 64 hex
  cid        TEXT NOT NULL,      -- IPFS CID the body was pinned under
  body       TEXT NOT NULL,      -- canonical CIP-108 JSON
  created_at INTEGER NOT NULL
);
