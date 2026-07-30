/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the notification_fanout_jobs durable outbox
// (migration 0064). buildJobInsert never executes: callers append it to their
// own db.batch alongside the vote/status write that caused the event, so job
// creation is atomic with the write it fans out from. All queries use
// prepare().bind() exclusively; never string-concatenated SQL.

export type FanoutEventType = 'delegator_drep_voted' | 'delegator_drep_re_voted' | 'delegator_drep_status_changed';

export interface FanoutJobRow {
  event_key: string;
  event_type: string;
  subject_id: string;
  source_time: number;
  payload: string;
  cursor_user_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface FanoutJobInput {
  eventKey: string;
  eventType: FanoutEventType;
  subjectId: string;
  sourceTime: number;
  payload: string;
  createdAt: number;
}

/**
 * Builds the (idempotent) job INSERT as a prepared statement, NOT executed:
 * the caller drops it into their own db.batch so the outbox row is committed
 * atomically with the write that caused it. INSERT OR IGNORE on the event_key
 * primary key, so a retried writer never double-creates a job for the same
 * event. cursor_user_id starts NULL; updated_at is seeded to createdAt.
 */
export function buildJobInsert(db: D1Database, job: FanoutJobInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO notification_fanout_jobs
         (event_key, event_type, subject_id, source_time, payload, cursor_user_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    )
    .bind(job.eventKey, job.eventType, job.subjectId, job.sourceTime, job.payload, job.createdAt, job.createdAt);
}

/** Open jobs (completed_at IS NULL), oldest first, stable tie-break on event_key. */
export async function listOpenJobs(db: D1Database, limit: number): Promise<FanoutJobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT event_key, event_type, subject_id, source_time, payload, cursor_user_id, created_at, updated_at, completed_at
       FROM notification_fanout_jobs
       WHERE completed_at IS NULL
       ORDER BY created_at, event_key
       LIMIT ?`,
    )
    .bind(limit)
    .all<FanoutJobRow>();
  return results;
}

/** Advances the fan-out pagination cursor after a batch of recipients is drained. */
export async function advanceJobCursor(
  db: D1Database,
  eventKey: string,
  cursorUserId: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare('UPDATE notification_fanout_jobs SET cursor_user_id = ?, updated_at = ? WHERE event_key = ?')
    .bind(cursorUserId, nowSec, eventKey)
    .run();
}

/** Marks a job's fan-out as fully drained. */
export async function completeJob(db: D1Database, eventKey: string, nowSec: number): Promise<void> {
  await db
    .prepare('UPDATE notification_fanout_jobs SET completed_at = ?, updated_at = ? WHERE event_key = ?')
    .bind(nowSec, nowSec, eventKey)
    .run();
}
