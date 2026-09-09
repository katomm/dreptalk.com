-- migrations/0096_survey_awaiting_final_index.sql
-- The surveys phase asks on every run which finalized surveys still owe their
-- tally artifact's count. Migration 0094 indexes only topic_id, so that query
-- walked the whole survey table to return an empty set in the steady state.
-- A partial index holds just the rows that are actually pending, so the probe
-- reads nothing while none are.
CREATE INDEX idx_survey_awaiting_final
  ON survey(ref)
  WHERE final_state = 'finalized' AND final_counted_dreps IS NULL;
