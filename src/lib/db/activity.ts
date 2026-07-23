/// <reference types="@cloudflare/workers-types" />
// Append only forum activity event log: an insert builder used by the emission
// sites (createTopic, createPost, opted-in vote-rationale cross-posts, gov sync
// discovery, gov tally sync) and the single read query that powers the "Latest
// activity" feed. The feed's hydration (titles, authors, governance) lives in
// src/lib/forum/activityFeed.ts.

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
 * Records a gov_status transition event, but only if one for the same topic and
 * target status does not already exist. A terminal transition happens once per
 * topic, so (topic_id, payload.to) is its stable identity: two overlapping tally
 * runs (both holding the pre-transition status), or a re-run over an
 * already-recorded transition, cannot double-post the same milestone to the feed.
 * The guard is a single INSERT ... WHERE NOT EXISTS, so it stays cheap and needs
 * no separate read.
 */
export async function insertGovStatusEventIfNew(
  db: D1Database,
  a: { topicId: string; from: string; to: string; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
       SELECT ?, 'gov_status', NULL, ?, NULL, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM activity
         WHERE type = 'gov_status' AND topic_id = ? AND json_extract(payload, '$.to') = ?
       )`,
    )
    .bind(crypto.randomUUID(), a.topicId, JSON.stringify({ from: a.from, to: a.to }), a.createdAt, a.topicId, a.to)
    .run();
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
// clause entirely. Constant per filter (never user input). 'comments' is all human
// forum activity: a new topic by a person counts like a reply, so it is included
// here (governance covers the system on-chain events). Together they partition the
// four types: every event is in exactly one of governance/comments.
const FILTER_TYPES: Record<'governance' | 'comments', ActivityKind[]> = {
  governance: ['gov_created', 'gov_status'],
  comments: ['topic_created', 'reply_created'],
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
  // Per governance action, surface only its newest lifecycle event, so the row
  // always reflects the action's current status: it reads "ratified" while ratified,
  // then flips to "enacted" (or expired/dropped/closed) once concluded, never both at
  // once. Governance events (gov_created + gov_status) share one partition per thread,
  // so only the newest survives; human events each get their own partition, so every
  // topic-start and reply is kept (discussion activity is never collapsed). gov_rn = 1
  // is the row to show.
  const cols = 'a.id, a.type, a.actor_id, a.topic_id, a.ref_post_id, a.payload, a.created_at';
  const ranked =
    `SELECT ${cols},
            ROW_NUMBER() OVER (
              PARTITION BY a.topic_id,
                CASE WHEN a.type IN ('gov_created', 'gov_status') THEN 'gov' ELSE a.id END
              ORDER BY a.created_at DESC, a.id DESC
            ) AS gov_rn
     FROM activity a JOIN topics t ON t.id = a.topic_id
     WHERE t.deleted = 0${typeClause}`;
  const base = `FROM (${ranked}) a WHERE a.gov_rn = 1`;

  const [pageRes, countRow] = await Promise.all([
    db
      .prepare(`SELECT ${cols} ${base} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
      .bind(...types, limit, offset)
      .all<ActivityRow>(),
    db.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...types).first<{ n: number }>(),
  ]);

  return { rows: pageRes.results ?? [], total: countRow?.n ?? 0 };
}
