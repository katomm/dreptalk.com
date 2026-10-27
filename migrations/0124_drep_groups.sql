-- DRep groups: a chain position is stored as five
-- columns with a shared prefix, <p>_h, <p>_ti, <p>_ph, <p>_ix and <p>_tx, compared as the row
-- value (<p>_h, <p>_ti, <p>_ph, <p>_ix), and a label tx kept without its CBOR is a marker
-- (marker = 1) that cannot change state. Every write batch starts with an insert into
-- drep_group_lease_check that fails its CHECK unless the caller still holds a live lease, so a
-- batch from a run that lost its lease rolls back as a whole.

-- Label transactions as discovered, with their payload or as a marker.
CREATE TABLE IF NOT EXISTS drep_group_txs (
  tx_hash TEXT PRIMARY KEY,
  block_height INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  marker INTEGER NOT NULL DEFAULT 0,
  payload BLOB,
  required_signers TEXT,
  witness_key_hashes TEXT,
  invalid_before TEXT,
  invalid_hereafter TEXT,
  is_valid INTEGER,
  payload_repeated INTEGER,
  bytes INTEGER,
  refetch INTEGER NOT NULL DEFAULT 0,
  refetch_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS drep_group_txs_label ON drep_group_txs (block_height, tx_index) WHERE marker = 0;
CREATE INDEX IF NOT EXISTS drep_group_txs_height ON drep_group_txs (block_height);
CREATE INDEX IF NOT EXISTS drep_group_txs_refetch ON drep_group_txs (block_height, tx_index) WHERE refetch = 1;
CREATE INDEX IF NOT EXISTS drep_group_txs_marker ON drep_group_txs (block_height) WHERE marker = 1 AND refetch = 0;

-- DRep registration and deregistration certificates of tracked credentials.
CREATE TABLE IF NOT EXISTS drep_group_ledger (
  tx_hash TEXT NOT NULL,
  cert_index INTEGER NOT NULL,
  cred TEXT NOT NULL,
  drep_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reg', 'unreg')),
  block_height INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  block_time INTEGER NOT NULL,
  witness BLOB,
  witness_state TEXT NOT NULL CHECK (witness_state IN ('na', 'pending', 'checked', 'skipped')),
  witness_attempts INTEGER NOT NULL DEFAULT 0,
  witness_retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, cert_index)
);
CREATE INDEX IF NOT EXISTS drep_group_ledger_cred ON drep_group_ledger (cred, block_height, tx_index, cert_index);
CREATE INDEX IF NOT EXISTS drep_group_ledger_unreg ON drep_group_ledger (cred, block_height, tx_index, cert_index) WHERE kind = 'unreg';
CREATE INDEX IF NOT EXISTS drep_group_ledger_height ON drep_group_ledger (block_height);
CREATE INDEX IF NOT EXISTS drep_group_ledger_pending ON drep_group_ledger (witness_retry_at, block_height, tx_index, cert_index) WHERE witness_state = 'pending';

-- Credentials whose ledger history is followed, oldest seq first.
CREATE TABLE IF NOT EXISTS drep_group_tracked (
  cred TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  drep_id TEXT,
  known INTEGER,
  history_done INTEGER NOT NULL DEFAULT 0,
  solo INTEGER NOT NULL DEFAULT 0,
  history_offset INTEGER NOT NULL DEFAULT 0,
  pending_witness INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0,
  found_h INTEGER, found_ti INTEGER, found_ph INTEGER, found_ix INTEGER, found_tx TEXT,
  applied_h INTEGER, applied_ti INTEGER, applied_ph INTEGER, applied_ix INTEGER, applied_tx TEXT,
  next_h INTEGER, next_ti INTEGER, next_ph INTEGER, next_ix INTEGER, next_tx TEXT,
  retiring INTEGER NOT NULL DEFAULT 0,
  retired_at_h INTEGER, retired_at_ti INTEGER, retired_at_ph INTEGER, retired_at_ix INTEGER, retired_at_tx TEXT,
  complete INTEGER GENERATED ALWAYS AS (CASE
    WHEN known = 0 THEN 1
    WHEN known = 1 AND history_done = 1 AND pending_witness = 0 THEN 1
    ELSE 0 END) STORED
);
CREATE INDEX IF NOT EXISTS drep_group_tracked_known ON drep_group_tracked (known, seq);
CREATE INDEX IF NOT EXISTS drep_group_tracked_history ON drep_group_tracked (known, history_done, solo, seq);
CREATE INDEX IF NOT EXISTS drep_group_tracked_ready ON drep_group_tracked (complete, known, next_h, next_ti, next_ph, next_ix) WHERE next_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_tracked_applied ON drep_group_tracked (applied_h) WHERE applied_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_tracked_next ON drep_group_tracked (next_h) WHERE next_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_tracked_found ON drep_group_tracked (found_h) WHERE found_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_tracked_retired ON drep_group_tracked (retired_at_h) WHERE retired_at_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_tracked_solo ON drep_group_tracked (solo) WHERE history_offset > 0;

-- pending_witness counts the ledger rows of a credential still waiting for their witness check.
CREATE TRIGGER IF NOT EXISTS drep_group_ledger_pending_ai AFTER INSERT ON drep_group_ledger
WHEN NEW.witness_state = 'pending' BEGIN
  UPDATE drep_group_tracked SET pending_witness = pending_witness + 1 WHERE cred = NEW.cred;
END;
CREATE TRIGGER IF NOT EXISTS drep_group_ledger_pending_ad AFTER DELETE ON drep_group_ledger
WHEN OLD.witness_state = 'pending' BEGIN
  UPDATE drep_group_tracked SET pending_witness = pending_witness - 1 WHERE cred = OLD.cred;
END;
CREATE TRIGGER IF NOT EXISTS drep_group_ledger_pending_au AFTER UPDATE OF witness_state, cred ON drep_group_ledger
WHEN (OLD.witness_state = 'pending' OR NEW.witness_state = 'pending')
  AND (OLD.witness_state IS NOT NEW.witness_state OR OLD.cred IS NOT NEW.cred) BEGIN
  UPDATE drep_group_tracked SET pending_witness = pending_witness - 1
    WHERE cred = OLD.cred AND OLD.witness_state = 'pending';
  UPDATE drep_group_tracked SET pending_witness = pending_witness + 1
    WHERE cred = NEW.cred AND NEW.witness_state = 'pending';
END;

-- Decoded membership events waiting for their credential unit.
CREATE TABLE IF NOT EXISTS drep_group_queue (
  tx_hash TEXT NOT NULL,
  idx INTEGER NOT NULL,
  subject TEXT NOT NULL,
  at_h INTEGER NOT NULL, at_ti INTEGER NOT NULL, at_ph INTEGER NOT NULL, at_ix INTEGER NOT NULL, at_tx TEXT NOT NULL,
  group_tx TEXT,
  group_ix INTEGER,
  event_json TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, idx)
);
CREATE INDEX IF NOT EXISTS drep_group_queue_subject ON drep_group_queue (subject, applied, at_h, at_ti, at_ph, at_ix);
CREATE INDEX IF NOT EXISTS drep_group_queue_group ON drep_group_queue (group_tx, group_ix, applied);
CREATE INDEX IF NOT EXISTS drep_group_queue_height ON drep_group_queue (at_h);

-- Signers and validity interval of label txs, as the rules read them.
CREATE TABLE IF NOT EXISTS drep_group_tx_context (
  tx_hash TEXT PRIMARY KEY,
  block_height INTEGER NOT NULL,
  tx_index INTEGER NOT NULL,
  signers TEXT NOT NULL,
  required_signers TEXT NOT NULL,
  invalid_before TEXT,
  invalid_hereafter TEXT
);
CREATE INDEX IF NOT EXISTS drep_group_tx_context_height ON drep_group_tx_context (block_height);

-- Native scripts published by label txs, by script hash.
CREATE TABLE IF NOT EXISTS drep_group_scripts (
  hash TEXT PRIMARY KEY,
  at_h INTEGER NOT NULL, at_ti INTEGER NOT NULL, at_ph INTEGER NOT NULL, at_ix INTEGER NOT NULL, at_tx TEXT NOT NULL,
  bytes BLOB NOT NULL,
  display_json TEXT
);
CREATE INDEX IF NOT EXISTS drep_group_scripts_height ON drep_group_scripts (at_h);

-- Member scripts of script credentials, from their registration witness.
CREATE TABLE IF NOT EXISTS drep_group_member_scripts (
  cred TEXT PRIMARY KEY,
  at_h INTEGER NOT NULL, at_ti INTEGER NOT NULL, at_ph INTEGER NOT NULL, at_ix INTEGER NOT NULL, at_tx TEXT NOT NULL,
  bytes BLOB NOT NULL,
  display_json TEXT
);
CREATE INDEX IF NOT EXISTS drep_group_member_scripts_height ON drep_group_member_scripts (at_h);

-- Every version of every group.
CREATE TABLE IF NOT EXISTS drep_group_versions (
  group_tx TEXT NOT NULL,
  group_ix INTEGER NOT NULL,
  at_h INTEGER NOT NULL, at_ti INTEGER NOT NULL, at_ph INTEGER NOT NULL, at_ix INTEGER NOT NULL, at_tx TEXT NOT NULL,
  mode TEXT NOT NULL,
  control TEXT NOT NULL,
  admission TEXT,
  profile_url TEXT,
  profile_hash TEXT,
  seq TEXT NOT NULL,
  status TEXT NOT NULL,
  created_h INTEGER NOT NULL, created_ti INTEGER NOT NULL, created_ph INTEGER NOT NULL, created_ix INTEGER NOT NULL, created_tx TEXT NOT NULL,
  profile_set_h INTEGER, profile_set_ti INTEGER, profile_set_ph INTEGER, profile_set_ix INTEGER, profile_set_tx TEXT,
  PRIMARY KEY (group_tx, group_ix, at_h, at_ti, at_ph, at_ix)
);
CREATE INDEX IF NOT EXISTS drep_group_versions_height ON drep_group_versions (at_h);
CREATE INDEX IF NOT EXISTS drep_group_versions_dissolved ON drep_group_versions (group_tx, group_ix) WHERE status = 'dissolved';

-- One row per group: its current version and the published counters.
CREATE TABLE IF NOT EXISTS drep_groups (
  group_tx TEXT NOT NULL,
  group_ix INTEGER NOT NULL,
  group_id TEXT NOT NULL UNIQUE,
  cur_h INTEGER NOT NULL, cur_ti INTEGER NOT NULL, cur_ph INTEGER NOT NULL, cur_ix INTEGER NOT NULL, cur_tx TEXT NOT NULL,
  mode TEXT NOT NULL,
  control TEXT NOT NULL,
  admission TEXT,
  profile_url TEXT,
  profile_hash TEXT,
  seq TEXT NOT NULL,
  status TEXT NOT NULL,
  created_h INTEGER NOT NULL, created_ti INTEGER NOT NULL, created_ph INTEGER NOT NULL, created_ix INTEGER NOT NULL, created_tx TEXT NOT NULL,
  profile_set_h INTEGER, profile_set_ti INTEGER, profile_set_ph INTEGER, profile_set_ix INTEGER, profile_set_tx TEXT,
  dissolved_h INTEGER, dissolved_ti INTEGER, dissolved_ph INTEGER, dissolved_ix INTEGER, dissolved_tx TEXT,
  members INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  former INTEGER NOT NULL DEFAULT 0,
  applied_events INTEGER NOT NULL DEFAULT 0,
  not_applied_events INTEGER NOT NULL DEFAULT 0,
  trimmed_applied INTEGER NOT NULL DEFAULT 0,
  trimmed_not_applied INTEGER NOT NULL DEFAULT 0,
  member_power INTEGER NOT NULL DEFAULT 0,
  closing INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_tx, group_ix)
);
CREATE INDEX IF NOT EXISTS drep_groups_listed ON drep_groups (member_power DESC, group_id) WHERE members >= 2;
CREATE INDEX IF NOT EXISTS drep_groups_cur ON drep_groups (cur_h);
CREATE INDEX IF NOT EXISTS drep_groups_dissolved ON drep_groups (dissolved_h) WHERE dissolved_h IS NOT NULL;

-- Membership instances, one per join, with the counted_as and effective close caches.
CREATE TABLE IF NOT EXISTS drep_group_instances (
  join_tx TEXT NOT NULL,
  join_ix INTEGER NOT NULL,
  group_tx TEXT NOT NULL,
  group_ix INTEGER NOT NULL,
  cred TEXT NOT NULL,
  drep_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  joined_h INTEGER NOT NULL, joined_ti INTEGER NOT NULL, joined_ph INTEGER NOT NULL, joined_ix INTEGER NOT NULL, joined_tx TEXT NOT NULL,
  approved_h INTEGER, approved_ti INTEGER, approved_ph INTEGER, approved_ix INTEGER, approved_tx TEXT,
  closed_h INTEGER, closed_ti INTEGER, closed_ph INTEGER, closed_ix INTEGER, closed_tx TEXT,
  close_reason TEXT,
  counted_as TEXT NOT NULL CHECK (counted_as IN ('open', 'pending', 'former')),
  eff_h INTEGER, eff_ti INTEGER, eff_ph INTEGER, eff_ix INTEGER, eff_tx TEXT,
  eff_reason TEXT,
  PRIMARY KEY (join_tx, join_ix)
);
CREATE INDEX IF NOT EXISTS drep_group_instances_counted ON drep_group_instances (group_tx, group_ix, counted_as, joined_h, joined_ti, joined_ph, joined_ix);
CREATE INDEX IF NOT EXISTS drep_group_instances_group ON drep_group_instances (group_tx, group_ix, joined_h, joined_ti, joined_ph, joined_ix);
CREATE INDEX IF NOT EXISTS drep_group_instances_member ON drep_group_instances (group_tx, group_ix, cred, joined_h, joined_ti, joined_ph, joined_ix);
CREATE INDEX IF NOT EXISTS drep_group_instances_cred ON drep_group_instances (cred, joined_h, joined_ti, joined_ph, joined_ix);
CREATE INDEX IF NOT EXISTS drep_group_instances_drep ON drep_group_instances (drep_id, counted_as, group_tx, group_ix);
CREATE INDEX IF NOT EXISTS drep_group_instances_height ON drep_group_instances (joined_h);
CREATE INDEX IF NOT EXISTS drep_group_instances_approved ON drep_group_instances (approved_h) WHERE approved_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_instances_closed ON drep_group_instances (closed_h) WHERE closed_h IS NOT NULL;

-- Rule outcomes of events per group, kept for the group history.
CREATE TABLE IF NOT EXISTS drep_group_verdicts (
  tx_hash TEXT NOT NULL,
  idx INTEGER NOT NULL,
  group_tx TEXT NOT NULL,
  group_ix INTEGER NOT NULL,
  at_h INTEGER NOT NULL, at_ti INTEGER NOT NULL, at_ph INTEGER NOT NULL, at_ix INTEGER NOT NULL, at_tx TEXT NOT NULL,
  tag TEXT NOT NULL,
  valid INTEGER NOT NULL,
  reason TEXT,
  subject TEXT,
  PRIMARY KEY (tx_hash, idx)
);
CREATE INDEX IF NOT EXISTS drep_group_verdicts_group ON drep_group_verdicts (group_tx, group_ix, valid, at_h, at_ti, at_ph, at_ix);
CREATE INDEX IF NOT EXISTS drep_group_verdicts_height ON drep_group_verdicts (at_h);

-- Restartable background jobs, one per kind and key.
CREATE TABLE IF NOT EXISTS drep_group_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('dissolve', 'retire', 'repair', 'recompute', 'trim', 'power', 'power-scan')),
  job_key TEXT NOT NULL,
  group_tx TEXT,
  group_ix INTEGER,
  cred TEXT,
  trigger_h INTEGER, trigger_ti INTEGER, trigger_ph INTEGER, trigger_ix INTEGER, trigger_tx TEXT,
  cursor_json TEXT,
  staging TEXT,
  start_gen INTEGER,
  UNIQUE (kind, job_key)
);
CREATE INDEX IF NOT EXISTS drep_group_jobs_kind ON drep_group_jobs (kind, id);
CREATE INDEX IF NOT EXISTS drep_group_jobs_group ON drep_group_jobs (kind, group_tx, group_ix);
CREATE INDEX IF NOT EXISTS drep_group_jobs_trigger ON drep_group_jobs (trigger_h) WHERE trigger_h IS NOT NULL;
CREATE INDEX IF NOT EXISTS drep_group_jobs_running ON drep_group_jobs (id) WHERE cursor_json IS NOT NULL;

-- DReps whose voting power changed while they hold an open instance, oldest seq first.
CREATE TABLE IF NOT EXISTS drep_group_power_changes (
  drep_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  after_key TEXT
);
CREATE INDEX IF NOT EXISTS drep_group_power_changes_seq ON drep_group_power_changes (seq);

-- Groups with verdicts beyond the retention window, by the height of the oldest one.
CREATE TABLE IF NOT EXISTS drep_group_trim_due (
  group_tx TEXT NOT NULL,
  group_ix INTEGER NOT NULL,
  oldest_h INTEGER NOT NULL,
  PRIMARY KEY (group_tx, group_ix)
);
CREATE INDEX IF NOT EXISTS drep_group_trim_due_height ON drep_group_trim_due (oldest_h);

-- Profile and website fetches that are due.
CREATE TABLE IF NOT EXISTS drep_group_due (
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'website')),
  group_tx TEXT NOT NULL,
  group_ix INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  PRIMARY KEY (kind, group_tx, group_ix)
);
CREATE INDEX IF NOT EXISTS drep_group_due_at ON drep_group_due (kind, due_at);

-- Single row: ingest frontiers, recovery slots, rebuild and probe state.
CREATE TABLE IF NOT EXISTS drep_group_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  L INTEGER NOT NULL,
  L_hash TEXT,
  R INTEGER,
  G_h INTEGER NOT NULL, G_ti INTEGER NOT NULL, G_ph INTEGER NOT NULL, G_ix INTEGER NOT NULL, G_tx TEXT NOT NULL,
  rec_first_kind TEXT,
  rec_first_above INTEGER,
  rec_first_time INTEGER,
  rec_then_above INTEGER,
  rec_then_time INTEGER,
  rec_phase TEXT,
  rebuilding INTEGER NOT NULL DEFAULT 0,
  lib_version TEXT,
  reg_time INTEGER,
  reg_offset INTEGER NOT NULL DEFAULT 0,
  probe_active INTEGER NOT NULL DEFAULT 0,
  probe_below INTEGER,
  operator_truncate INTEGER,
  power_seq INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO drep_group_meta (id, L, R, G_h, G_ti, G_ph, G_ix, G_tx, lib_version, reg_offset, rebuilding, probe_active)
VALUES (1, -1, NULL, -1, 9007199254740991, 2, 9007199254740991, '', NULL, 0, 0, 0);

-- Singleton lease against overlapping runs, and the guard table its CHECK lives on.
CREATE TABLE IF NOT EXISTS drep_group_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  token TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drep_group_lease_check (
  ok INTEGER NOT NULL,
  CONSTRAINT lease_ok CHECK (ok = 1)
);

-- Fetched group profiles (off-chain anchor documents).
CREATE TABLE IF NOT EXISTS drep_group_profiles (
  group_id TEXT PRIMARY KEY,
  profile_url TEXT,
  data_hash TEXT,
  status TEXT,
  name TEXT,
  description TEXT,
  website TEXT,
  image TEXT,
  charter TEXT,
  payment_addresses_json TEXT,
  fetched_at INTEGER,
  website_verified_at INTEGER,
  website_checked_at INTEGER
);

-- A voting power change of a DRep with an open instance queues it for the power scan,
-- in the same statement as the dreps write. A queued DRep restarts its keyset.
CREATE TRIGGER IF NOT EXISTS dreps_group_power_ai AFTER INSERT ON dreps
WHEN EXISTS (SELECT 1 FROM drep_group_instances WHERE drep_id = NEW.drep_id AND counted_as = 'open') BEGIN
  UPDATE drep_group_meta SET power_seq = power_seq + 1 WHERE id = 1;
  INSERT OR REPLACE INTO drep_group_power_changes (drep_id, seq, after_key)
    VALUES (NEW.drep_id, (SELECT power_seq FROM drep_group_meta WHERE id = 1), NULL);
END;
CREATE TRIGGER IF NOT EXISTS dreps_group_power_au AFTER UPDATE OF voting_power ON dreps
WHEN OLD.voting_power IS NOT NEW.voting_power
  AND EXISTS (SELECT 1 FROM drep_group_instances WHERE drep_id = NEW.drep_id AND counted_as = 'open') BEGIN
  UPDATE drep_group_meta SET power_seq = power_seq + 1 WHERE id = 1;
  INSERT OR REPLACE INTO drep_group_power_changes (drep_id, seq, after_key)
    VALUES (NEW.drep_id, (SELECT power_seq FROM drep_group_meta WHERE id = 1), NULL);
END;
