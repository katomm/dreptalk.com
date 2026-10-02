// src/lib/db/delegationDigest.ts
/// <reference types="@cloudflare/workers-types" />
// The delegator epoch digest. Once the vote cron has finished a clean run
// inside the current epoch, the completed epoch (current - 1) is summarized
// once per followed DRep into delegation_digest_dreps and marked built in
// delegation_digest_epochs, in one atomic batch. Each later run writes digests
// for up to `recipients` followers with a single INSERT ... SELECT, in follow
// index order and only for DReps that voted in the epoch, so a capped run continues
// where the previous one stopped and silent DReps never block anyone. When a
// check finds nobody left, the epoch is marked done and later runs cost one
// query. Idempotency comes from the notifications (recipient_id, event_key)
// partial unique index. The notification retention from PR #589 cannot cause
// a duplicate: digests are only written for current - 1, and the summary
// tables keep the last two epochs. All queries use .prepare().bind().

import { epochFromUnix, epochStartUnix, epochStartMs, type NetworkConfig } from '../config/network.js';
import {
  DIGEST_TITLE_CHARS,
  DIGEST_TITLE_MAX,
  isReportable,
  type DelegationDigestPayload,
} from '../notifications/delegationDigest.js';
import type { Allowance } from '../sync/queryBudget.js';
import { getFollowedDrepIds } from './delegatorFollows.js';
import { confirmedVoteSql } from './drepVotes.js';
import { chunked, DB_NOW_MS } from './sql.js';

// DRep ids per IN list. The vote query binds the list twice plus four bounds,
// 2 * 45 + 4 = 94 stays under D1's 100 cap.
const DREP_CHUNK = 45;
// 4 binds per summary row.
const SUMMARY_INSERT_CHUNK = 24;


export type DigestRunState = 'waiting' | 'sending' | 'done' | 'deferred';

/**
 * True once the vote cron finished a run that started inside the current
 * epoch and whose votes phase succeeded without failed actions, so votes of
 * the completed epoch on actions that are still open are in. Votes on an
 * action that closed at the boundary are not refetched (Known limitations).
 */
export async function digestReady(db: D1Database, currentEpoch: number, cfg: NetworkConfig): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM sync_runs r
        WHERE r.kind = 'votes' AND r.finished_at IS NOT NULL AND r.started_at >= ?
          AND EXISTS (SELECT 1 FROM json_each(r.phases) p
                       WHERE json_extract(p.value, '$.phase') = 'votes'
                         AND json_extract(p.value, '$.ok') = 1
                         AND json_extract(p.value, '$.failed') = 0)
        LIMIT 1`,
    )
    .bind(epochStartMs(currentEpoch, cfg))
    .first<{ ok: number }>();
  return row !== null;
}

/** Queries a build issues for this many followed DReps, batch statements counted singly. */
export function buildCost(followedCount: number): number {
  // 1 per vote chunk + 2 deletes + summary inserts + epoch row.
  return Math.ceil(followedCount / DREP_CHUNK) + 2 + Math.ceil(followedCount / SUMMARY_INSERT_CHUNK) + 1;
}

const clip = (t: string) => (t.length <= DIGEST_TITLE_CHARS ? t : `${t.slice(0, DIGEST_TITLE_CHARS - 1).trimEnd()}…`);

/**
 * Summarizes the given DReps for the epoch and stores the rows plus the epoch
 * marker in one batch, which D1 runs as a transaction. INSERT OR IGNORE, so a
 * run that raced this one keeps the first result. An epoch without a single
 * reportable DRep is marked done right away.
 */
export async function buildDrepSummaries(
  db: D1Database,
  epoch: number,
  cfg: NetworkConfig,
  followed: string[],
): Promise<{ dreps: number; reportable: number }> {
  const start = epochStartUnix(epoch, cfg);
  const end = epochStartUnix(epoch + 1, cfg);
  // Votes inside the epoch, from the current vote and from superseded ones,
  // newest first. The chunks are independent, so they run concurrently.
  const voteChunks = await Promise.all(
    chunked(followed, DREP_CHUNK).map(async (part) => {
      const marks = part.map(() => '?').join(', ');
      return (
        await db
          .prepare(
            `SELECT x.voter_id AS voter_id, x.ga_id AS ga_id, x.meta_url AS meta_url, g.title AS title
               FROM (
                 SELECT voter_id, ga_id, block_time, meta_url FROM drep_votes
                  WHERE voter_role = 'DRep' AND voter_id IN (${marks})
                    AND block_time >= ? AND block_time < ? AND ${confirmedVoteSql()}
                 UNION ALL
                 SELECT voter_id, ga_id, block_time, meta_url FROM drep_vote_history
                  WHERE voter_role = 'DRep' AND voter_id IN (${marks})
                    AND block_time >= ? AND block_time < ?
               ) x
               LEFT JOIN governance_actions g ON g.id = x.ga_id
              ORDER BY x.block_time DESC, x.ga_id`,
          )
          .bind(...part, start, end, ...part, start, end)
          .all<{ voter_id: string; ga_id: string; meta_url: string | null; title: string | null }>()
      ).results;
    }),
  );

  // Newest version per (DRep, action) inside the epoch.
  const votesBy = new Map<string, { title: string | null; meta: string | null }[]>();
  for (const rows of voteChunks) {
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.voter_id}\u0000${r.ga_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = votesBy.get(r.voter_id) ?? [];
      list.push({ title: r.title, meta: r.meta_url });
      votesBy.set(r.voter_id, list);
    }
  }

  const rows = followed.map((drepId) => {
    const votes = votesBy.get(drepId) ?? [];
    const payload: DelegationDigestPayload = {
      epoch,
      drepId,
      votes: votes.length,
      withRationale: votes.filter((v) => v.meta != null && v.meta !== '').length,
      titles: votes
        .map((v) => v.title?.trim() ?? '')
        .filter((t) => t !== '')
        .slice(0, DIGEST_TITLE_MAX)
        .map(clip),
      openUnvoted: null, // legacy field, see DelegationDigestPayload
    };
    return { drepId, payload, reportable: isReportable(payload) };
  });
  const reportable = rows.filter((r) => r.reportable).length;

  await db.batch([
    db.prepare('DELETE FROM delegation_digest_dreps WHERE epoch < ?').bind(epoch - 1),
    db.prepare('DELETE FROM delegation_digest_epochs WHERE epoch < ?').bind(epoch - 1),
    ...chunked(rows, SUMMARY_INSERT_CHUNK).map((c) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO delegation_digest_dreps (epoch, drep_id, payload, reportable)
           VALUES ${c.map(() => '(?, ?, ?, ?)').join(', ')}`,
        )
        .bind(...c.flatMap((r) => [epoch, r.drepId, JSON.stringify(r.payload), r.reportable ? 1 : 0])),
    ),
    db
      .prepare(
        `INSERT OR IGNORE INTO delegation_digest_epochs (epoch, built_at, done_at)
         VALUES (?, ${DB_NOW_MS}, CASE WHEN ? = 0 THEN ${DB_NOW_MS} END)`,
      )
      .bind(epoch, reportable),
  ]);
  return { dreps: rows.length, reportable };
}

// Followers of reportable DReps without a digest for the epoch (?1), active
// accounts only. Shared by the insert and the done check. The event key suffix
// (?2, ":<epoch>") is built in JS and bound as text: D1 binds a JS number as a
// real, which would concatenate as "300.0".
const PENDING_RECIPIENTS = `
  FROM delegation_digest_dreps s
  JOIN delegator_follows f
    ON f.drep_id = s.drep_id AND f.resolution_status = 'resolved' AND f.delegation_type = 'drep'
  JOIN users u ON u.id = f.user_id AND u.status = 'active'
 WHERE s.epoch = ?1 AND s.reportable = 1
   AND NOT EXISTS (
     SELECT 1 FROM notifications n
      WHERE n.recipient_id = f.user_id AND n.event_key = 'delegation_digest:' || f.user_id || ?2)`;

const keySuffix = (epoch: number) => `:${epoch}`;

/**
 * Writes digests for up to `limit` pending followers in one statement, so the
 * follow and account checks hold for the very rows written. Returns the
 * number of rows inserted. created_at comes from the D1 clock.
 */
export async function sendDigests(db: D1Database, epoch: number, limit: number): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
       SELECT lower(hex(randomblob(16))), f.user_id, 'delegation_digest',
              'delegation_digest:' || f.user_id || ?2, s.payload, ${DB_NOW_MS}
       ${PENDING_RECIPIENTS}
        ORDER BY f.drep_id, f.user_id
        LIMIT ?3
       ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    )
    .bind(epoch, keySuffix(epoch), limit)
    .run();
  return res.meta.changes ?? 0;
}

async function anyPending(db: D1Database, epoch: number): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS x ${PENDING_RECIPIENTS} LIMIT 1`).bind(epoch, keySuffix(epoch)).first()) !== null;
}

/**
 * One notifications-cron pass. Steady state after an epoch is done: one query.
 * The build runs once per epoch and only when its cost fits the allowance,
 * otherwise the pass defers with a warning. A send pass costs one insert, plus
 * a check and a done mark when fewer rows than the limit were written.
 */
export async function runDelegationDigest(
  db: D1Database,
  cfg: NetworkConfig,
  nowSec: number,
  opts: { budget: Allowance; recipients: number },
): Promise<{ epoch: number; state: DigestRunState; inserted: number }> {
  const { budget, recipients } = opts;
  const current = epochFromUnix(nowSec, cfg);
  const epoch = current - 1;
  if (!budget.covers(1)) return { epoch, state: 'deferred', inserted: 0 };
  const marker = await db
    .prepare('SELECT done_at FROM delegation_digest_epochs WHERE epoch = ?')
    .bind(epoch)
    .first<{ done_at: number | null }>();
  if (marker?.done_at != null) return { epoch, state: 'done', inserted: 0 };

  if (!marker) {
    if (!budget.covers(2)) return { epoch, state: 'deferred', inserted: 0 };
    if (!(await digestReady(db, current, cfg))) return { epoch, state: 'waiting', inserted: 0 };
    const followed = [...(await getFollowedDrepIds(db))];
    const cost = buildCost(followed.length);
    if (!budget.covers(cost)) {
      console.warn(`[delegation-digest] build for ${followed.length} DReps needs ${cost} queries, ${budget.remaining()} left, deferred`);
      return { epoch, state: 'deferred', inserted: 0 };
    }
    const r = await buildDrepSummaries(db, epoch, cfg, followed);
    if (r.reportable === 0) return { epoch, state: 'done', inserted: 0 };
  }
  if (!budget.covers(3)) return { epoch, state: 'deferred', inserted: 0 };

  const inserted = await sendDigests(db, epoch, recipients);
  if (inserted >= recipients) return { epoch, state: 'sending', inserted };
  // Fewer than the limit: either the rest is done, or a concurrent run wrote
  // some of this page. Only a check that finds nobody left marks the epoch.
  if (await anyPending(db, epoch)) return { epoch, state: 'sending', inserted };
  await db
    .prepare(`UPDATE delegation_digest_epochs SET done_at = ${DB_NOW_MS} WHERE epoch = ? AND done_at IS NULL`)
    .bind(epoch)
    .run();
  return { epoch, state: 'done', inserted };
}
