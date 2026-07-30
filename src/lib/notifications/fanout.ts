/// <reference types="@cloudflare/workers-types" />
// Durable delegator-notification fan-out worker. Drains notification_fanout_jobs
// (migration 0064) into per-recipient rows in the notifications table.
// listOpenJobs/advanceJobCursor/completeJob are the outbox primitives (Tasks
// 1-4, src/lib/db/fanoutJobs.ts); this module never writes to the outbox
// table directly. subject_id on every job type is the DRep id, so followers
// are always matched by drep_id = job.subject_id.
import { listOpenJobs, advanceJobCursor, completeJob, type FanoutJobRow } from '../db/fanoutJobs.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PASSES = 50;
// 6 binds per row; 14 rows keep a statement under D1's 100-bind-param limit
// (miniflare does not enforce the limit, so tests alone would not catch this).
const INSERT_CHUNK = 14;

interface FollowerRow {
  user_id: string;
}

/**
 * Runs one draining cycle over the open fan-out jobs. Fairness: each pass
 * advances every still-open job by exactly one page of followers, so a
 * mega-job (many followers) can never starve a small job behind it; passes
 * repeat until no open jobs remain or maxPasses is reached.
 *
 * now is unix SECONDS (the outbox's unit); the notifications this worker
 * writes use now * 1000 as created_at (notifications.created_at is unix
 * MILLISECONDS, matching the rest of the notifications table) so a
 * notification is dated by when it was MATERIALIZED, not by the job's
 * source_time. This is deliberate: a push channel's delivered_until cursor
 * is compared against created_at, and it must see a late-drained event as
 * "new" even if the underlying on-chain event happened long ago.
 */
export async function runFanout(
  db: D1Database,
  now: number,
  opts: { pageSize?: number; maxPasses?: number } = {},
): Promise<{ jobs: number; delivered: number; completed: number }> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;

  const touchedJobs = new Set<string>();
  let delivered = 0;
  let completed = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const openJobs = await listOpenJobs(db, 1000);
    if (openJobs.length === 0) break;

    for (const job of openJobs) {
      touchedJobs.add(job.event_key);
      const drained = await processOnePage(db, job, pageSize, now);
      delivered += drained.delivered;
      if (drained.completed) completed += 1;
    }
  }

  return { jobs: touchedJobs.size, delivered, completed };
}

/** Processes exactly one follower page for one job: insert, advance/complete. */
async function processOnePage(
  db: D1Database,
  job: FanoutJobRow,
  pageSize: number,
  now: number,
): Promise<{ delivered: number; completed: boolean }> {
  const cursor = job.cursor_user_id ?? '';
  const { results: followers } = await db
    .prepare(
      `SELECT user_id FROM delegator_follows
        WHERE resolution_status = 'resolved' AND delegation_type = 'drep'
          AND drep_id = ?1 AND delegation_set_at <= ?2 AND user_id > ?3
        ORDER BY user_id
        LIMIT ?4`,
    )
    .bind(job.subject_id, job.source_time, cursor, pageSize)
    .all<FollowerRow>();

  const delivered = followers.length > 0 ? await insertNotificationPage(db, job, followers, now) : 0;

  const drained = followers.length < pageSize;
  if (drained) {
    await completeJob(db, job.event_key, now);
  } else {
    const lastUserId = followers[followers.length - 1].user_id;
    await advanceJobCursor(db, job.event_key, lastUserId, now);
  }

  return { delivered, completed: drained };
}

/**
 * Inserts one notification row per follower, chunked under the bind-param
 * limit, all chunks in one db.batch. Returns the number of rows actually
 * inserted (meta.changes), so ON CONFLICT-skipped duplicates are not counted
 * as delivered.
 */
async function insertNotificationPage(
  db: D1Database,
  job: FanoutJobRow,
  followers: FollowerRow[],
  now: number,
): Promise<number> {
  const createdAt = now * 1000;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < followers.length; i += INSERT_CHUNK) {
    const chunk = followers.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    statements.push(
      db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
           VALUES ${values}
           ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        )
        .bind(
          ...chunk.flatMap((f) => [crypto.randomUUID(), f.user_id, job.event_type, job.event_key, job.payload, createdAt]),
        ),
    );
  }
  const results = await db.batch(statements);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}
