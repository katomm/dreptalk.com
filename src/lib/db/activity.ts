/// <reference types="@cloudflare/workers-types" />
// Append only forum activity event log: an insert builder used by the four
// emission sites (createTopic, createPost, gov sync discovery, gov tally sync)
// and the single read query that powers the "Latest activity" feed. The feed's
// hydration (titles, authors, governance) lives in src/lib/forum/activityFeed.ts.

export type ActivityKind = 'topic_created' | 'reply_created' | 'gov_created' | 'gov_status';

// Raw row shape as stored in D1. payload is a JSON string (or null); the feed
// loader parses it for gov_status.
export interface ActivityRow {
  id: string;
  type: ActivityKind;
  actor_id: string | null;
  topic_id: string;
  ref_post_id: string | null;
  payload: string | null;
  created_at: number;
}

/**
 * Builds an INSERT for one activity event as a prepared statement, so callers
 * can append it to their existing D1 batch (the event is then atomic with the
 * write that caused it). The id is a fresh UUID; payload is JSON-encoded when
 * present. System events (gov_created, gov_status) pass no actorId.
 */
export function activityInsert(
  db: D1Database,
  a: {
    type: ActivityKind;
    topicId: string;
    actorId?: string | null;
    refPostId?: string | null;
    payload?: Record<string, unknown> | null;
    createdAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      a.type,
      a.actorId ?? null,
      a.topicId,
      a.refPostId ?? null,
      a.payload ? JSON.stringify(a.payload) : null,
      a.createdAt,
    );
}

/**
 * Returns the newest activity events, newest first. The id DESC tiebreaker keeps
 * the order deterministic when two events share a created_at (backfilled rows
 * commonly do). Default limit 30, capped at 50.
 */
export async function getRecentActivity(
  db: D1Database,
  opts?: { limit?: number },
): Promise<ActivityRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 50);
  const rows = await db
    .prepare('SELECT * FROM activity ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(limit)
    .all<ActivityRow>();
  return rows.results ?? [];
}
