-- Precomputed report-card percentiles per DRep, replaced atomically by the
-- 6-hourly drep-report-card sync phase. Only cohort members (active DReps
-- with at least 5 eligible decided actions, specials excluded) get a row.
-- The profile shows no percentile without one. The pct values are the
-- metric values AT COMPUTE TIME (ranking transparency), the profile keeps
-- displaying its live values and only attaches the percentile.
CREATE TABLE drep_report_card (
  drep_id TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  participation_pct REAL NOT NULL,
  participation_ahead_pct INTEGER NOT NULL,
  rationale_pct REAL,
  rationale_ahead_pct INTEGER,
  eligible INTEGER NOT NULL,
  cohort_size INTEGER NOT NULL,
  rationale_cohort_size INTEGER NOT NULL
);
