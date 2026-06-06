CREATE TABLE drep_metadata (
  drep_id     TEXT PRIMARY KEY,         -- CIP-129 DRep id
  body        TEXT NOT NULL,            -- the exact JSON we serve (immutable per registration)
  hash        TEXT NOT NULL,            -- blake2b-256 hex of body bytes
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL          -- unix seconds
);
