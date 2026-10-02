-- The delegator epoch summary is opt-in for push and Telegram. It shipped
-- switched on for every channel, which repeated the per-vote notifications
-- and sent summaries without a single vote. Every connected channel kind gets
-- an explicit "off" row, replacing the "on" row seeded by channels created
-- since. New channels seed it off themselves (prefDefault). The inbox row is
-- unaffected, prefs only gate push and Telegram.
INSERT OR REPLACE INTO notification_prefs (user_id, channel, event_type, enabled)
SELECT DISTINCT user_id, channel, 'delegation_digest', 0 FROM notification_channels;
