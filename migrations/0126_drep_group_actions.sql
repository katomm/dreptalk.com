-- DRep group actions: the multisig signing table also carries group transactions, and the engine
-- gets the tables that resolve, notify and host for them. subject_kind tells the rows apart: 'drep'
-- for votes (every existing row), 'member' for a join or leave, 'group' for everything else.
-- drep_id holds the subject id. Chain hashes in the engine tables are BLOBs, the signing table
-- keeps its hex text.

ALTER TABLE pending_multisig_tx ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'drep';
ALTER TABLE pending_multisig_tx ADD COLUMN required_signers TEXT;
ALTER TABLE pending_multisig_tx ADD COLUMN invalid_hereafter INTEGER;
ALTER TABLE pending_multisig_tx ADD COLUMN fee_inputs TEXT;
ALTER TABLE pending_multisig_tx ADD COLUMN event_count INTEGER;
ALTER TABLE pending_multisig_tx ADD COLUMN control_slot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_multisig_tx ADD COLUMN profile_hash TEXT;
ALTER TABLE pending_multisig_tx ADD COLUMN resolution TEXT;
ALTER TABLE pending_multisig_tx ADD COLUMN resolved_at INTEGER;
ALTER TABLE pending_multisig_tx ADD COLUMN resolved_h INTEGER;
ALTER TABLE pending_multisig_tx ADD COLUMN never_included_at INTEGER;
ALTER TABLE pending_multisig_tx ADD COLUMN spent_seen_h INTEGER;
ALTER TABLE pending_multisig_tx ADD COLUMN cancelled_at INTEGER;

CREATE INDEX IF NOT EXISTS pending_multisig_tx_subject ON pending_multisig_tx (subject_kind, drep_id, status);
CREATE INDEX IF NOT EXISTS pending_multisig_tx_body ON pending_multisig_tx (body_hash);
CREATE INDEX IF NOT EXISTS pending_multisig_tx_profile ON pending_multisig_tx (profile_hash) WHERE profile_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS pending_multisig_tx_open_control ON pending_multisig_tx (drep_id) WHERE control_slot = 1 AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS pending_multisig_tx_unresolved ON pending_multisig_tx (invalid_hereafter) WHERE subject_kind != 'drep' AND resolved_at IS NULL;

-- Verdicts of tracked transactions, written by the engine commit and read by the resolver.
CREATE TABLE IF NOT EXISTS drep_group_own_outcomes (
  tx_hash TEXT NOT NULL,
  idx INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  reason TEXT,
  at_h INTEGER NOT NULL,
  written_at INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, idx)
);
CREATE INDEX IF NOT EXISTS drep_group_own_outcomes_h ON drep_group_own_outcomes (at_h);

-- Key hash of every published script, to find the groups a key may act for.
CREATE TABLE IF NOT EXISTS drep_group_policy_keys (
  key BLOB NOT NULL,
  script BLOB NOT NULL,
  PRIMARY KEY (key, script)
);
CREATE INDEX IF NOT EXISTS drep_groups_control ON drep_groups (control);
CREATE INDEX IF NOT EXISTS drep_groups_admission ON drep_groups (admission) WHERE admission IS NOT NULL;

-- Profile anchor hashes referenced by stored label transactions.
CREATE TABLE IF NOT EXISTS drep_group_anchor_refs (
  hash BLOB NOT NULL,
  tx_hash BLOB NOT NULL,
  PRIMARY KEY (hash, tx_hash)
);

-- Permissioned join requests waiting for a notification to the approvers.
CREATE TABLE IF NOT EXISTS drep_group_join_notify (
  join_tx BLOB NOT NULL,
  join_ix INTEGER NOT NULL,
  join_h INTEGER NOT NULL,
  PRIMARY KEY (join_tx, join_ix)
);
CREATE INDEX IF NOT EXISTS drep_group_join_notify_h ON drep_group_join_notify (join_h);

-- Profile documents hosted for group anchors.
CREATE TABLE IF NOT EXISTS drep_group_profile_docs (
  hash TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  anchored INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS drep_group_profile_docs_unanchored ON drep_group_profile_docs (created_at) WHERE anchored = 0;
