/// <reference types="@cloudflare/workers-types" />
// Append only forum activity event log: an insert builder used by the four
// emission sites (createTopic, createPost, gov sync discovery, gov tally sync)
// and the single read query that powers the "Latest activity" feed. The feed's
// hydration (titles, authors, governance) lives in src/lib/forum/activityFeed.ts.

import { sqlPlaceholders } from './sql.js';

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

// Activity types each feed filter includes. 'all' is handled by skipping the type
// clause entirely. Constant per filter (never user input).
const FILTER_TYPES: Record<'governance' | 'comments', ActivityKind[]> = {
  governance: ['gov_created', 'gov_status'],
  comments: ['reply_created'],
};

/**
 * One page of activity events for a feed filter, newest first, joined to topics
 * so deleted-topic events are excluded in SQL (the count then matches the rows).
 * 'all' applies no type clause; 'governance'/'comments' restrict by type. Returns
 * the page rows plus the full matching count for pagination. limit clamped to
 * [1,50]; offset >= 0. The id DESC tiebreaker keeps equal-created_at order stable.
 */
export async function getActivityPage(
  db: D1Database,
  opts: { filter: 'all' | 'governance' | 'comments'; limit: number; offset: number },
): Promise<{ rows: ActivityRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const offset = Math.max(opts.offset, 0);

  const types = opts.filter === 'all' ? [] : FILTER_TYPES[opts.filter];
  const typeClause = types.length ? ` AND a.type IN (${sqlPlaceholders(types)})` : '';
  const base = `FROM activity a JOIN topics t ON t.id = a.topic_id WHERE t.deleted = 0${typeClause}`;

  const [pageRes, countRow] = await Promise.all([
    db
      .prepare(`SELECT a.* ${base} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
      .bind(...types, limit, offset)
      .all<ActivityRow>(),
    db.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...types).first<{ n: number }>(),
  ]);

  return { rows: pageRes.results ?? [], total: countRow?.n ?? 0 };
}
