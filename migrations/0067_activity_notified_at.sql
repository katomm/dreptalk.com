-- Governance activity events (gov_created, gov_status) are dated at their
-- on-chain epoch boundary (created_at), which can be several days before the
-- cron actually discovers them. The notification cursors (the header badge's
-- notif_seen_at and each push channel's delivered_until) only count events
-- NEWER than the cursor, so a freshly discovered action that is back-dated
-- before the cursor was silently treated as already delivered and never
-- notified. In practice this meant governance-action pushes almost never fired.
--
-- notified_at records when we LEARNED of the event (real wall-clock detection
-- time), independent of when it happened on chain. The feed keeps ordering by
-- created_at (so an action still shows at its true submission date), while the
-- notification queries switch to notified_at, so a newly discovered action is
-- "new" relative to every cursor set before this run.
ALTER TABLE activity ADD COLUMN notified_at INTEGER;

-- Existing rows have no separate detection time; seed it from created_at. This
-- keeps their notification behaviour unchanged (old actions stay "already
-- seen"), so the fix is forward-only and never re-notifies historical events.
UPDATE activity SET notified_at = created_at WHERE notified_at IS NULL;

-- The notification queries range-scan notified_at (> cursor), so index it the
-- same way created_at is indexed for the feed.
CREATE INDEX idx_activity_notified ON activity(notified_at);
