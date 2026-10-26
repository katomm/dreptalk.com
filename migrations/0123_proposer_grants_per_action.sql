-- 0123_proposer_grants_per_action.sql
-- Co-proposer grants bind to one governance action instead of one proposer.
-- The table is rebuilt rather than altered: both nets held zero rows on
-- 2026-10-26, so nothing needs backfilling, and the old unique index on
-- co_stake_addr alone would block one key from holding grants on two actions.
-- gov_action_id and team_label stay nullable so the previous code, which does
-- not know either column, keeps inserting until the new code is deployed. The
-- new code ignores and sweeps rows without a gov_action_id.
-- topics.proposer_grant_id and posts.proposer_grant_id are untouched.
DROP TABLE proposer_grants;

CREATE TABLE proposer_grants (
  id                  TEXT PRIMARY KEY,
  proposer_user_id    TEXT NOT NULL,
  proposer_stake_addr TEXT NOT NULL,
  gov_action_id       TEXT,
  team_label          TEXT,
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

-- One active mandate per co stake key and governance action.
CREATE UNIQUE INDEX idx_proposer_grants_active_co_action
  ON proposer_grants(co_stake_addr, gov_action_id)
  WHERE status = 'active' AND co_stake_addr IS NOT NULL;

CREATE INDEX idx_proposer_grants_proposer
  ON proposer_grants(proposer_user_id, status);

CREATE INDEX idx_proposer_grants_action
  ON proposer_grants(gov_action_id, status);
