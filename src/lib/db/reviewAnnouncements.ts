/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for review_announcements (migration 0111): the
// Governance Review editions announced so far. Announcing an edition writes
// one review_published notification per account in the same batch, so from
// there on it is an ordinary personal notification: the bell, the inbox and
// the push/Telegram dispatch need nothing special for it.

/** The edition the site currently serves, as the cron reads it. */
export interface LatestEdition {
  edition: number;
  slug: string;
  title: string;
}

export type AnnounceOutcome = 'seeded' | 'announced' | 'none';

/**
 * Records the live edition as announced when it is newer than every edition
 * announced so far, and notifies every account about it. The very first call
 * only seeds (announced_at 0, no notifications), so the editions already live
 * when this shipped never notify. A revised edition keeps its number and an
 * older one merged later (a backfill) is below the maximum, so neither
 * announces. When a deploy skips numbers only the newest edition is recorded.
 * Both writes run in one batch (one transaction), and both are idempotent
 * (INSERT OR IGNORE on the edition, the event_key index on notifications), so
 * two overlapping cron runs announce an edition once.
 */
export async function announceLatestEdition(
  db: D1Database,
  latest: LatestEdition,
  now: number,
): Promise<AnnounceOutcome> {
  const row = await db
    .prepare('SELECT MAX(edition) AS max FROM review_announcements')
    .first<{ max: number | null }>();
  const max = row?.max ?? null;
  if (max !== null && latest.edition <= max) return 'none';

  const record = db
    .prepare(
      `INSERT OR IGNORE INTO review_announcements (edition, slug, title, announced_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(latest.edition, latest.slug, latest.title, max === null ? 0 : now);
  if (max === null) {
    const res = await record.run();
    return (res.meta.changes ?? 0) > 0 ? 'seeded' : 'none';
  }

  // One row per account, the two built-in actors excluded (the same pair the
  // last_seen backfill in migration 0076 skips).
  const fanout = db
    .prepare(
      `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
       SELECT lower(hex(randomblob(16))), id, 'review_published', ?1, ?2, ?3
         FROM users WHERE id NOT IN ('system', 'gov-sync')
       ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    )
    .bind(`review:${latest.edition}`, JSON.stringify(latest), now);
  const [recorded] = await db.batch([record, fanout]);
  return (recorded.meta.changes ?? 0) > 0 ? 'announced' : 'none';
}

/** The review_published payload, or null for anything malformed. */
export function parseReviewPayload(payload: string | null): LatestEdition | null {
  if (!payload) return null;
  try {
    const { edition, slug, title } = JSON.parse(payload) as Record<string, unknown>;
    if (typeof edition !== 'number' || typeof slug !== 'string' || typeof title !== 'string') return null;
    return { edition, slug, title };
  } catch {
    return null;
  }
}
