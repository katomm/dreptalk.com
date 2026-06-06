-- Governance actions ingested by the gov-sync cron worker.
-- One row per on-chain governance action; id is "<txHash>#<index>".
-- Tally columns are nullable and populated by a later sync phase.
CREATE TABLE IF NOT EXISTS governance_actions (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  title           TEXT,
  abstract        TEXT,
  rationale_html  TEXT,
  anchor_url      TEXT,
  anchor_hash     TEXT,
  anchor_status   TEXT NOT NULL DEFAULT 'pending',
  return_address  TEXT,
  deposit         TEXT,
  submitted_epoch INTEGER,
  expiry_epoch    INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',
  drep_yes        INTEGER,
  drep_no         INTEGER,
  drep_abstain    INTEGER,
  spo_yes         INTEGER,
  spo_no          INTEGER,
  spo_abstain     INTEGER,
  cc_yes          INTEGER,
  cc_no           INTEGER,
  cc_abstain      INTEGER,
  topic_id        TEXT,
  created_at      INTEGER NOT NULL,
  last_synced_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_governance_actions_status ON governance_actions(status, expiry_epoch);
CREATE INDEX IF NOT EXISTS idx_governance_actions_topic ON governance_actions(topic_id);
