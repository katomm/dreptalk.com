-- Users: one row per account, keyed by the primary verified credential.
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  drep_id          TEXT,
  stake_addr       TEXT,
  pool_id          TEXT,
  cc_cred          TEXT,
  is_drep          INTEGER NOT NULL DEFAULT 0,
  is_spo           INTEGER NOT NULL DEFAULT 0,
  is_cc            INTEGER NOT NULL DEFAULT 0,
  is_proposer      INTEGER NOT NULL DEFAULT 0,
  role             TEXT NOT NULL DEFAULT 'member',
  status           TEXT NOT NULL DEFAULT 'active',
  display_name     TEXT,
  bio              TEXT,
  avatar_url       TEXT,
  created_at       INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_drep_id ON users(drep_id);
CREATE INDEX IF NOT EXISTS idx_users_stake_addr ON users(stake_addr);
-- created_at/last_verified_at 0 = sentinel: system account, not a real timestamp
INSERT OR IGNORE INTO users (id, role, status, display_name, created_at, last_verified_at)
VALUES ('system', 'system', 'active', 'DRepTalk', 0, 0);
