-- migrations/0099_survey_tally.sql
-- The informational tally of a CIP-179 survey, precomputed by the gov-sync
-- surveys phase so the thread page renders it from D1 and never calls Tessera.
-- Derived data: every row is bound to the sources it was computed from and is
-- invalidated rather than patched when one of them moves. The numeric figures
-- and the JSON's per-question bar bases are defined in
-- src/lib/surveys/surveyTallyContract.ts rather than here.
CREATE TABLE survey_tally (
  survey_ref      TEXT PRIMARY KEY,
  -- Where the WEIGHTED questions come from: 'live' (our own audit, weighted at
  -- power_epoch) or 'artifact' (the hash-committed final tally, weighted at the
  -- survey's end_epoch). The head count and the exclusions are always our own
  -- audit, because an artifact carries neither.
  weighted_source TEXT NOT NULL,
  -- The artifact the weighted questions came from, NULL on the live path. A
  -- changed survey.artifact_hash invalidates this row.
  artifact_hash   TEXT,
  power_epoch     INTEGER NOT NULL,
  -- Where the HEAD COUNT questions come from: 'audit' (run A over the bundle)
  -- or 'artifact'. A sealed survey is the only 'artifact' case: auditResponses
  -- counts a sealed response for participation but cannot see its answers, and
  -- decrypting them is out of scope, so its per-question head counts are the
  -- artifact's post-membership set and the card says so.
  headcount_source TEXT NOT NULL,
  -- {"headcount": ArtifactQuestion[], "weighted": ArtifactQuestion[]} as JSON.
  -- Both arrays are the cip-179 ArtifactQuestion shape, so one projection
  -- serves the live and the final path alike.
  questions       TEXT NOT NULL,
  -- Audited DRep responses, from the unit-weight run. The head count of record.
  counted         INTEGER NOT NULL,
  -- Of those, the ones given a weight. Zero weight is included, so this is
  -- never described as "carries voting power".
  matched_count   INTEGER NOT NULL,
  answered_power  TEXT NOT NULL,
  -- Representative DRep power at power_epoch, NULL when unknown. Never 0 for
  -- unknown, because 0 is a legitimate value.
  total_power     TEXT,
  -- Excluded responses claiming role DRep.
  excluded        INTEGER NOT NULL,
  -- JSON, ExclusionKey to count. NULL means the breakdown is unknown, which is
  -- a different thing from {} and must never be stored as {}.
  excluded_by     TEXT,
  -- Counted responses per claimed role, JSON, role int to count. Feeds the line
  -- naming that other roles responded, which must never be derived from
  -- eligible_roles: admission proves permission, never participation.
  role_counts     TEXT,
  bundle_fetched_at INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL
);

-- Durable work list. The mirror persists its delta cursor before the later
-- passes run, so a survey the tally pass could not reach this run would
-- otherwise never be "delivered by this run's delta" again. A row is deleted
-- only once a tally has been written for it.
CREATE TABLE survey_tally_queue (
  survey_ref   TEXT PRIMARY KEY,
  queued_at    INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER
);

-- Least recently attempted first, so one oversized survey cannot starve the
-- queue. NULLs sort first in SQLite, which is what we want: never tried beats
-- tried and failed.
CREATE INDEX idx_survey_tally_queue_work ON survey_tally_queue(last_attempt, queued_at);
