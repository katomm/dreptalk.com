-- 0068_proposer_grants.sql
-- Co-proposer mandates: a proposer invites another stake key via a one-time
-- code; the redeemed grant lets that key write on the proposer's behalf.
-- Posts persist the grant id so attribution is historical (survives revoke).
CREATE TABLE proposer_grants (
  id                  TEXT PRIMARY KEY,
  proposer_user_id    TEXT NOT NULL,
  proposer_stake_addr TEXT NOT NULL,
  co_user_id          TEXT,
  co_stake_addr       TEXT,
  invite_code_hash    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'revoked')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  redeemed_at         INTEGER,
  revoked_at          INTEGER
);

CREATE UNIQUE INDEX idx_proposer_grants_invite_hash
  ON proposer_grants(invite_code_hash);

-- One active mandate per co stake key (partial unique, same style as 0062).
CREATE UNIQUE INDEX idx_proposer_grants_active_co
  ON proposer_grants(co_stake_addr)
  WHERE status = 'active' AND co_stake_addr IS NOT NULL;

CREATE INDEX idx_proposer_grants_proposer
  ON proposer_grants(proposer_user_id, status);

-- Historical mandate attribution, copied from the session at write time.
ALTER TABLE topics ADD COLUMN proposer_grant_id TEXT;
ALTER TABLE posts ADD COLUMN proposer_grant_id TEXT;
