-- Durable outbox for delegator-notification fan-out (Phase 4). A job row is
-- materialized atomically alongside the vote/status write that caused it
-- (event_key is the idempotency key, so a retried writer never double-creates
-- one). A drain worker then pages through the affected delegators using
-- cursor_user_id and marks the job done via completed_at. updated_at advances
-- on every cursor step and on completion, so a stuck job (created_at old,
-- updated_at old, completed_at still NULL) is visible for monitoring.
CREATE TABLE notification_fanout_jobs (
  event_key      TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,    -- FanoutEventType
  subject_id     TEXT NOT NULL,    -- the drep_id or ga-scoped subject the event is about
  source_time    INTEGER NOT NULL, -- unix seconds, the on-chain/originating event time
  payload        TEXT NOT NULL,    -- JSON string, event-type-specific
  cursor_user_id TEXT,             -- fan-out pagination cursor; NULL until the drain starts
  created_at     INTEGER NOT NULL, -- unix seconds, outbox materialization time
  updated_at     INTEGER NOT NULL, -- unix seconds, advanced on every cursor step/completion
  completed_at   INTEGER           -- unix seconds, NULL while the fan-out is still open
);

-- Open-job scan for the drain worker: oldest first, stable tie-break on event_key.
CREATE INDEX idx_fanout_jobs_open
  ON notification_fanout_jobs (created_at, event_key)
  WHERE completed_at IS NULL;
