-- Governance Review announcements: one row per edition the site announced to
-- its users, written by the gov-sync cron once a new edition is live. A
-- broadcast like the governance events: no per-recipient rows, the bell and the
-- push/Telegram dispatch compare announced_at (unix ms) against their cursors.
-- The first row is a silent seed (announced_at = 0), so editions published
-- before this table existed never notify anyone.
CREATE TABLE IF NOT EXISTS review_announcements (
  edition INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  announced_at INTEGER NOT NULL
);
