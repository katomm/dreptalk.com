-- Group descriptions keep their line breaks since this change. Profiles fetched before it were
-- stored as one line, so every group with a stored profile gets its profile due again once. The
-- fetcher drops a due row whose group has no member or no anchor, so stale rows clear themselves.
INSERT OR IGNORE INTO drep_group_due (kind, group_tx, group_ix, due_at)
SELECT 'profile', group_tx, group_ix, 0 FROM drep_group_profiles WHERE status = 'ok' AND description IS NOT NULL;
