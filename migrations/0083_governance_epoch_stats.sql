-- Per-epoch network governance aggregates: the analytics backbone.
-- The binding metric contract (definition, truth source, reliability and
-- series-start rule of every column) lives in
-- src/lib/analytics/epochStatsContract.ts.
-- Representative columns EXCLUDE the special auto-voting ids
-- (drep_always_abstain, drep_always_no_confidence). The specials form the
-- default delegation layer and get their own columns.
-- Rows for past epochs are written once (INSERT OR IGNORE by the backfill).
-- The current epoch's row is recomputed each cron run until the epoch ends,
-- and rows with vote_data_complete = 0 get their vote-derived columns
-- repaired once the vote-history sweep has drained.
CREATE TABLE governance_epoch_stats (
  epoch INTEGER PRIMARY KEY,
  -- lovelace, summed over the epoch's non-special snapshot rows
  total_drep_power TEXT NOT NULL,
  -- non-special snapshot rows with amount > 0 this epoch
  powered_drep_count INTEGER NOT NULL,
  -- distinct non-special DReps with at least one on-chain vote in the
  -- trailing RECENT_VOTING_WINDOW_EPOCHS epochs (superseded votes count),
  -- exact only where vote_data_complete = 1
  recently_voting_drep_count INTEGER NOT NULL,
  -- default delegation layer, NULL when Koios served no row for the epoch
  abstain_power TEXT,
  anc_power TEXT,
  -- forward-only: sum of live-observed delegator counts, set ONLY when every
  -- snapshot row of the epoch carries an observation, never a partial sum
  delegator_total INTEGER,
  -- forward-only live observations of the two special ids
  abstain_delegators INTEGER,
  anc_delegators INTEGER,
  -- concentration over the non-special amount distribution (powered only)
  gini REAL NOT NULL,
  top10_share_pct REAL NOT NULL,
  min_coalition_50 INTEGER NOT NULL,
  min_coalition_67 INTEGER NOT NULL,
  -- DRep vote transactions in the epoch, superseded included, local data,
  -- exact only where vote_data_complete = 1
  votes_cast INTEGER NOT NULL,
  -- 1 when zero governance_actions had vote_history_swept_at IS NULL at
  -- compute time. Gates BOTH votes_cast and recently_voting_drep_count,
  -- they derive from the same drep_votes + drep_vote_history source.
  vote_data_complete INTEGER NOT NULL,
  -- lovelace, from Koios /totals for the epoch
  treasury_lovelace TEXT,
  computed_at INTEGER NOT NULL
);
