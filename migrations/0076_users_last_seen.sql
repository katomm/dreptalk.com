-- migrations/0076_users_last_seen.sql
-- Usage/activity signal: last time the user was seen on the site (Unix ms),
-- written at session mint and on the 6h sliding renewal (see db/users.bumpLastSeen).
-- Deliberately milliseconds, unlike the seconds-based created_at/last_verified_at.
ALTER TABLE users ADD COLUMN last_seen INTEGER;
CREATE INDEX idx_users_last_seen ON users(last_seen);

-- One-shot seed so the 30-day view has data immediately instead of a cold start.
-- last_seen = max of:
--   (a) last_verified_at, stored in SECONDS today, so *1000. The < 1e12 guard is
--       defensive for any historical row already in ms.
--   (b) the user's most recent QUALIFYING post (already ms), matching the exact
--       visibility filters of the old card: p.deleted=0, p.hidden=0, t.deleted=0.
-- last_verified_at is NOT NULL with 0 as the system sentinel, so only rows with a
-- real login (> 0) or a qualifying post are seeded, everything else stays NULL.
-- Reserved accounts (system, gov-sync) are never seeded.
-- Mirrored as a tested fixture in src/lib/db/lastSeenBackfill.ts (keep equivalent).
UPDATE users
SET last_seen = MAX(
  CASE
    WHEN last_verified_at < 1000000000000 THEN last_verified_at * 1000
    ELSE last_verified_at
  END,
  COALESCE((
    SELECT MAX(p.created_at) FROM posts p
    JOIN topics t ON t.id = p.topic_id
    WHERE p.author_id = users.id AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
  ), 0)
)
WHERE users.id NOT IN ('system', 'gov-sync')
  AND (
    last_verified_at > 0
    OR EXISTS (
      SELECT 1 FROM posts p JOIN topics t ON t.id = p.topic_id
      WHERE p.author_id = users.id AND p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
    )
  );
