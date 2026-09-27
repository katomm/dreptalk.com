-- Notification dispatch rotation and inbox retention (spec 2026-09-26).
--
-- dispatch_attempted_at: unix ms of the last dispatcher claim on this channel.
-- The dispatcher reads candidates least recently attempted first, so a capped
-- run rotates through a backlog instead of always serving the same channels.
-- It replaces the plain channel index, whose prefix it covers.
ALTER TABLE notification_channels ADD COLUMN dispatch_attempted_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_notification_channels_dispatch ON notification_channels(channel, dispatch_attempted_at);
DROP INDEX idx_notification_channels_channel;

-- Retention scan: rows older than the read cutoff, oldest first.
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Fan-out rotation: open jobs least recently advanced first, so a job that got
-- a page moves behind jobs that did not, across runs.
CREATE INDEX idx_fanout_jobs_open_rotation
  ON notification_fanout_jobs(updated_at, event_key) WHERE completed_at IS NULL;
DROP INDEX idx_fanout_jobs_open;
