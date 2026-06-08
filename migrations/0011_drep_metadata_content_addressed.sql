-- Content-address the hosted DRep metadata so an unauthenticated write can
-- never overwrite a legitimate row. The primary key becomes (drep_id, hash):
-- different content -> different hash -> different row; re-posting identical
-- content is an idempotent no-op. Authenticity of what is displayed is enforced
-- separately by syncDreps verifying blake2b-256(body) == the on-chain anchor.
--
-- Destructive recreate is safe: this table is a hosting cache only (the chain is
-- the source of truth) and DReps re-host on their next registration.
DROP TABLE IF EXISTS drep_metadata;
CREATE TABLE drep_metadata (
  drep_id     TEXT NOT NULL,            -- CIP-129 DRep id
  body        TEXT NOT NULL,            -- the exact JSON we serve (content-addressed by hash)
  hash        TEXT NOT NULL,            -- blake2b-256 hex of body bytes
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,         -- unix seconds
  PRIMARY KEY (drep_id, hash)
);
CREATE INDEX idx_drep_metadata_created ON drep_metadata(created_at);
