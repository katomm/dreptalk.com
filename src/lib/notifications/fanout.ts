/// <reference types="@cloudflare/workers-types" />
// Durable delegator-notification fan-out worker. Drains notification_fanout_jobs
// (migration 0064) into per-recipient rows in the notifications table.
// listOpenJobs/buildAdvanceJobCursor/buildCompleteJob are the outbox primitives
// (Tasks 1-4, src/lib/db/fanoutJobs.ts); this module never writes to the
// outbox table directly. subject_id on every job type is the DRep id, so
// followers are always matched by drep_id = job.subject_id.
import { DB_NOW_MS } from '../db/sql.js';
import { listOpenJobs, buildAdvanceJobCursor, buildCompleteJob, type FanoutJobRow } from '../db/fanoutJobs.js';
import type { Allowance } from '../sync/queryBudget.js';
import { UNLIMITED } from '../sync/queryBudget.js';

const DEFAULT_PAGE_SIZE = 100;
// 6 binds per row; 14 rows keep a statement under D1's 100-bind-param limit
// (miniflare does not enforce the limit, so tests alone would not catch this).
const INSERT_CHUNK = 14;

interface FollowerRow {
  user_id: string;
}

/** Queries one page costs: the follower select plus the insert chunks and the cursor step in one batch. */
export function fanoutPageCost(pageSize: number): number {
  return 1 + Math.ceil(pageSize / INSERT_CHUNK) + 1;
}

/**
 * Runs one draining cycle over the open fan-out jobs, spending at most the
 * given allowance. Fairness: each pass advances every listed open job by
 * exactly one page of followers, so a mega-job (many followers) can never
 * starve a small job behind it; passes repeat until no open jobs remain or
 * the allowance cannot cover another pass, in which case deferred is true
 * and the jobs left behind keep their cursor to be reached on the next run
 * (see listOpenJobs' rotation order).
 *
 * deferred is true only when work may remain: a job processed in the last
 * pass did not complete, the last pass could not list as many jobs as it
 * found (there may be more beyond what the allowance could afford to list),
 * or the allowance ran out mid-pass before a listed job could be processed.
 * To tell "that was every open job" from "there may be more beyond this
 * listing" without a separate count query, each pass asks listOpenJobs for
 * one row more than it can afford to process. The listing is billed as one
 * query regardless of LIMIT, so the peek costs nothing extra.
 *
 * now is unix SECONDS (the outbox's unit), used only for the job table's
 * updated_at / completed_at. The notifications this worker writes get
 * created_at from the database clock at insert time (DB_NOW_MS), not from
 * now and not from the job's source_time. This is deliberate: a push
 * channel's delivered_until cursor is compared against created_at, and it
 * must see a late-drained event as "new" even if the underlying on-chain
 * event happened long ago.
 */
export async function runFanout(
  db: D1Database,
  now: number,
  opts: { pageSize?: number; allowance?: Allowance } = {},
): Promise<{ jobs: number; delivered: number; completed: number; deferred: boolean }> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const budget = opts.allowance ?? UNLIMITED;
  const pageCost = fanoutPageCost(pageSize);
  const touchedJobs = new Set<string>();
  let delivered = 0;
  let completed = 0;

  // Each pass gives every listed open job one page, least recently advanced first,
  // so a mega job never starves a small one. The allowance ends the run; jobs not
  // reached keep their cursor and sort first on the next run.
  for (;;) {
    if (!budget.covers(1 + pageCost)) return { jobs: touchedJobs.size, delivered, completed, deferred: true };
    const affordable = Math.floor((budget.remaining() - 1) / pageCost);
    const limit = Math.min(1000, affordable);
    const openJobs = await listOpenJobs(db, limit + 1);
    if (openJobs.length === 0) return { jobs: touchedJobs.size, delivered, completed, deferred: false };
    // More open jobs exist than this pass can afford to process: the ones
    // beyond the affordable count are left for a later pass or run.
    const truncated = openJobs.length > limit;
    const toProcess = truncated ? openJobs.slice(0, limit) : openJobs;

    let allCompleted = true;
    for (const job of toProcess) {
      if (!budget.covers(pageCost)) return { jobs: touchedJobs.size, delivered, completed, deferred: true };
      touchedJobs.add(job.event_key);
      const drained = await processOnePage(db, job, pageSize, now);
      delivered += drained.delivered;
      if (drained.completed) completed += 1;
      else allCompleted = false;
    }

    // Every listed job completed and there is nothing beyond this listing:
    // the run is done, not deferred. Otherwise loop again, budget permitting,
    // rather than guessing from the allowance alone.
    if (!truncated && allCompleted) return { jobs: touchedJobs.size, delivered, completed, deferred: false };
  }
}

/** Processes exactly one follower page for one job: insert and advance/complete in one atomic batch. */
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

  const drained = followers.length < pageSize;
  const step = drained
    ? buildCompleteJob(db, job.event_key, now)
    : buildAdvanceJobCursor(db, job.event_key, followers[followers.length - 1].user_id, now);

  // Inserts and the cursor step commit together: a page is either fully
  // recorded or not at all, so a retry never re-inserts rows whose step was lost.
  const results = await db.batch([...buildNotificationPage(db, job, followers), step]);
  const delivered = results.slice(0, -1).reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  return { delivered, completed: drained };
}

/**
 * Builds the (unrun) insert statements for one page of followers, chunked
 * under the bind-param limit, for the caller's page batch. Returns an empty
 * array when there are no followers. Each row's created_at is DB_NOW_MS, the
 * database clock at the moment the batch commits.
 */
function buildNotificationPage(db: D1Database, job: FanoutJobRow, followers: FollowerRow[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < followers.length; i += INSERT_CHUNK) {
    const chunk = followers.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => `(?, ?, ?, ?, ?, ${DB_NOW_MS})`).join(', ');
    statements.push(
      db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
           VALUES ${values}
           ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        )
        .bind(...chunk.flatMap((f) => [crypto.randomUUID(), f.user_id, job.event_type, job.event_key, job.payload])),
    );
  }
  return statements;
}
