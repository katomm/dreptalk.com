-- Single-row cache of the current CIP-1694 voting thresholds (from Koios
-- epoch_params) plus the constitutional-committee quorum, refreshed by gov-sync.
-- One row, id = 1. Thresholds are fractions 0..1; null when not yet synced.
CREATE TABLE IF NOT EXISTS protocol_params (
  id                         INTEGER PRIMARY KEY,
  epoch                      INTEGER,
  dvt_motion_no_confidence   REAL,
  dvt_committee_normal       REAL,
  dvt_committee_no_confidence REAL,
  dvt_update_constitution    REAL,
  dvt_hard_fork              REAL,
  dvt_pp_network             REAL,
  dvt_pp_economic            REAL,
  dvt_pp_technical           REAL,
  dvt_pp_gov                 REAL,
  dvt_treasury_withdrawal    REAL,
  pvt_motion_no_confidence   REAL,
  pvt_committee_normal       REAL,
  pvt_committee_no_confidence REAL,
  pvt_hard_fork              REAL,
  pvt_security_group         REAL,
  cc_threshold               REAL,
  committee_min_size         INTEGER,
  synced_at                  INTEGER NOT NULL
);
