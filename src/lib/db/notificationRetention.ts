/// <reference types="@cloudflare/workers-types" />
// Inbox retention for personal notification rows. Read rows go 90 days after
// they were created, every row 365 days after. Governance entries in the inbox
// come from the public activity feed and are not touched here.
//
// Deleting cannot cause a duplicate delivery: every producer that relies on the
// (recipient_id, event_key) unique index has its own gate or a key that cannot
// recur after 90 days (spec 2026-09-26, section 5).

const DAY_MS = 86_400_000;
export const READ_RETENTION_DAYS = 90;
export const ALL_RETENTION_DAYS = 365;
const DEFAULT_BATCH = 500;
const DEFAULT_MAX_BATCHES = 40;

export async function pruneNotifications(
  db: D1Database,
  nowMs: number,
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<{ deleted: number; batches: number; capped: boolean }> {
  const batch = opts.batch ?? DEFAULT_BATCH;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  const readCutoff = nowMs - READ_RETENTION_DAYS * DAY_MS;
  const allCutoff = nowMs - ALL_RETENTION_DAYS * DAY_MS;
  let deleted = 0;
  for (let batches = 1; batches <= maxBatches; batches++) {
    const res = await db
      .prepare(
        `DELETE FROM notifications
          WHERE id IN (
            SELECT id FROM notifications
             WHERE created_at < ?1
               AND (read_at IS NOT NULL OR created_at < ?2)
             LIMIT ?3)`,
      )
      .bind(readCutoff, allCutoff, batch)
      .run();
    const n = res.meta.changes ?? 0;
    deleted += n;
    if (n < batch) return { deleted, batches, capped: false };
  }
  return { deleted, batches: maxBatches, capped: true };
}
