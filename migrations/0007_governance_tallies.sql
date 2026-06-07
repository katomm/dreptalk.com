-- Governance-action tallies and per-post vote badges.
-- The bech32 proposal_id is needed for the Koios voting-summary/votes endpoints.
-- Power-weighted yes/no percentages (Koios computes them) drive the tally bars;
-- the existing drep_/spo_/cc_ INTEGER columns hold the votes_cast counts.
ALTER TABLE governance_actions ADD COLUMN proposal_id TEXT;
ALTER TABLE governance_actions ADD COLUMN drep_yes_pct REAL;
ALTER TABLE governance_actions ADD COLUMN drep_no_pct REAL;
ALTER TABLE governance_actions ADD COLUMN spo_yes_pct REAL;
ALTER TABLE governance_actions ADD COLUMN spo_no_pct REAL;
ALTER TABLE governance_actions ADD COLUMN cc_yes_pct REAL;
ALTER TABLE governance_actions ADD COLUMN cc_no_pct REAL;
ALTER TABLE governance_actions ADD COLUMN tally_epoch INTEGER;
ALTER TABLE governance_actions ADD COLUMN tally_synced_at INTEGER;

-- One row per on-chain vote on an action; the post-author match drives the
-- per-post vote badge. PK dedups per voter; index serves the per-thread load.
CREATE TABLE IF NOT EXISTS drep_votes (
  ga_id      TEXT NOT NULL,
  voter_role TEXT NOT NULL,
  voter_id   TEXT NOT NULL,
  voter_hex  TEXT,
  vote       TEXT NOT NULL,
  synced_at  INTEGER NOT NULL,
  PRIMARY KEY (ga_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_drep_votes_ga ON drep_votes(ga_id);

-- Cross-category "latest activity" query for the forum overview.
CREATE INDEX IF NOT EXISTS idx_topics_last_post ON topics(last_post_at);
