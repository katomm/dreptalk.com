CREATE TABLE dreps (
  drep_id          TEXT PRIMARY KEY,
  hex              TEXT,
  has_script       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,         -- koios drep_status
  active           INTEGER NOT NULL DEFAULT 0,
  deposit          TEXT,
  voting_power     TEXT,                  -- koios "amount" (lovelace)
  expires_epoch_no INTEGER,
  name             TEXT,                  -- CIP-119 givenName
  bio              TEXT,                  -- CIP-119 bio/objectives (plain)
  image_url        TEXT,                  -- on-chain image URL; served via our proxy, never hot-linked
  links            TEXT,                  -- JSON array of {label, uri}
  anchor_url       TEXT,
  anchor_hash      TEXT,
  anchor_status    TEXT NOT NULL DEFAULT 'pending',
  last_synced_at   INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_dreps_status_active ON dreps(status, active);
CREATE INDEX idx_dreps_last_synced ON dreps(last_synced_at);
