-- Single-row snapshot of the network-wide vote-timing aggregates, recomputed
-- by the dreps cron. Read by analytics.astro and my-governance-record.astro
-- instead of running the window-function queries live on every render. One row,
-- id = 1, overwritten in place each sync (mirrors drep_report_card).
CREATE TABLE voting_timing_snapshot (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  payload     TEXT    NOT NULL,
  computed_at INTEGER NOT NULL,
  epoch       INTEGER NOT NULL
);
