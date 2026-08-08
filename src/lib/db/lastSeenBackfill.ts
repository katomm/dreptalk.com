// Test fixture mirroring the backfill UPDATE in migrations/0076_users_last_seen.sql.
// The migration is the deployed copy, this exists only so a workers test can run
// the same statement against seeded data. Keep the two equivalent by hand.
export const LAST_SEEN_BACKFILL_SQL = `
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
  );`;
