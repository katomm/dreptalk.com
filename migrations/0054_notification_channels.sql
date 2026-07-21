-- Notification delivery channels and per-channel event-type preferences
-- (design doc section 1, Phase 2). The inbox itself has no prefs; these
-- tables only exist for external channels (webpush now, telegram later).
--
-- notification_channels: one row per connected deliverer. For webpush that is
-- one row PER DEVICE (browser push subscription JSON in target). The
-- delivered_until cursor implements the design's delivery contract: the cron
-- dispatcher sends everything newer than the cursor and only advances it on
-- success, so a failed delivery is retried on the next run.
CREATE TABLE notification_channels (
  id              TEXT PRIMARY KEY,     -- crypto.randomUUID()
  user_id         TEXT NOT NULL,        -- users.id
  channel         TEXT NOT NULL,        -- 'webpush' (later: 'telegram')
  target          TEXT NOT NULL,        -- webpush: PushSubscription JSON {endpoint, keys:{p256dh, auth}}
  endpoint        TEXT NOT NULL,        -- the subscription endpoint, the stable per-device identity, deduped per user
  created_at      INTEGER NOT NULL,
  delivered_until INTEGER NOT NULL      -- unix ms cursor; starts at creation time
);
CREATE INDEX idx_notification_channels_user ON notification_channels(user_id);
-- The dispatcher scans all channels of one kind each run.
CREATE INDEX idx_notification_channels_channel ON notification_channels(channel);
-- Re-enabling push on an already-connected device must update the existing
-- row instead of creating a duplicate, since subscribe() returns the same
-- endpoint on repeat.
CREATE UNIQUE INDEX idx_notification_channels_endpoint ON notification_channels(user_id, endpoint);

-- The channel x event-type matrix. Rows are created all-enabled when a channel
-- kind is first connected; a missing row counts as enabled (default-on), so
-- only explicit opt-outs strictly need to persist.
CREATE TABLE notification_prefs (
  user_id    TEXT NOT NULL,
  channel    TEXT NOT NULL,             -- 'webpush' (later: 'telegram')
  event_type TEXT NOT NULL,             -- 'reply' | 'mention' | 'governance'
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, channel, event_type)
);
