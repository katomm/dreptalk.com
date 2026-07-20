-- Personal notifications: one row per (recipient, event). Broadcast events
-- (gov_created / gov_status) are NOT materialized here; the inbox merges them
-- from the activity table at read time, using users.notif_seen_at as the read
-- cursor. payload is reserved for future notification types and stays NULL for
-- reply / mention.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,      -- crypto.randomUUID()
  recipient_id TEXT NOT NULL,         -- users.id
  type         TEXT NOT NULL,         -- 'reply' | 'mention' (future: 'delegation' | 'message')
  actor_id     TEXT,                  -- user who caused the event; NULL for system types
  topic_id     TEXT,                  -- deep-link target, hydrated at read time
  post_id      TEXT,                  -- deep-link anchor within the topic
  payload      TEXT,                  -- JSON, reserved; NULL today
  created_at   INTEGER NOT NULL,
  read_at      INTEGER                -- NULL = unread
);

-- The inbox's only access patterns: newest per recipient, unread count per recipient.
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, created_at DESC);

-- Read cursor for broadcast (gov) events merged from activity.
ALTER TABLE users ADD COLUMN notif_seen_at INTEGER NOT NULL DEFAULT 0;
