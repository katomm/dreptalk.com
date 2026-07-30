-- Per-account tracked delegation. "delegator" is a login intent, not a role.
-- resolution_status is two-valued (pending|resolved); a failed refresh is the
-- orthogonal refresh_error_at, never a status that drops the baseline.
-- refresh_attempted_at (advanced on every attempt, success or failure) drives a
-- fair, truly-daily due window and prevents starvation by never-resolved rows.
CREATE TABLE delegator_follows (
  user_id              TEXT NOT NULL,
  stake_addr           TEXT NOT NULL,
  resolution_status    TEXT NOT NULL,   -- 'pending' | 'resolved'
  delegation_type      TEXT,            -- 'drep'|'abstain'|'no_confidence'|'none', NULL while pending
  drep_id              TEXT,            -- non-null iff delegation_type = 'drep'
  checked_at           INTEGER,         -- unix seconds of the last SUCCESSFUL resolution
  delegation_set_at    INTEGER,         -- unix seconds since DRepTalk confirmed the current state
  refresh_attempted_at INTEGER,         -- unix seconds of the last attempt (success OR failure)
  refresh_error_at     INTEGER,         -- unix seconds of the last failed refresh, else NULL
  PRIMARY KEY (user_id),
  UNIQUE (stake_addr),
  CHECK (
    (resolution_status = 'resolved'
      AND delegation_type IN ('drep','abstain','no_confidence','none')
      AND ((delegation_type = 'drep' AND drep_id IS NOT NULL)
           OR (delegation_type != 'drep' AND drep_id IS NULL)))
    OR
    (resolution_status = 'pending'
      AND delegation_type IS NULL AND drep_id IS NULL
      AND checked_at IS NULL AND delegation_set_at IS NULL)
  )
);

-- Fan-out pagination (Phase 4): WHERE drep_id=? AND user_id>? ORDER BY user_id.
CREATE INDEX idx_delegator_follows_drep_user
  ON delegator_follows(drep_id, user_id)
  WHERE resolution_status = 'resolved' AND delegation_type = 'drep';

-- Due-window scan for the bulk refresh: stalest attempt first.
CREATE INDEX idx_delegator_follows_attempted
  ON delegator_follows(refresh_attempted_at);

-- Idempotency key for event-based personal notifications (delegation_changed is
-- the first). NULL for the pre-existing reply/mention/device_paired rows.
ALTER TABLE notifications ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX idx_notifications_event_key
  ON notifications(recipient_id, event_key) WHERE event_key IS NOT NULL;
