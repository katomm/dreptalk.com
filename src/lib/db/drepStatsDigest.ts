/// <reference types="@cloudflare/workers-types" />
// The DRep stats epoch digest, once per epoch each DRep account holder gets
// at most one notification when their voting power or delegator count moved
// beyond the trigger thresholds (notifications/drepStats.ts). Idempotency
// comes from the notifications (recipient_id, event_key) partial unique index
// with event_key drep_stats:<drepId>:<epoch>, so re-running a sync pass never
// double-notifies and no epoch cursor is needed. Candidates are filtered to
// is_drep = 1 AND status = 'active' (recipient semantics, and deliberately
// disabled accounts never get digests even though no code path disables
// accounts today). A candidate also requires the CURRENT epoch's delegator
// count to be stamped, the digest promises both values, and firing without
// the count would freeze a partial digest forever behind the event_key, so it
// waits for the next sync pass instead (bounded by the dreps cron cadence).
// All queries use .prepare().bind() exclusively, never string-concatenated
// SQL.

import { evaluateDrepStats } from '../notifications/drepStats.js';

interface CandidateRow {
  user_id: string;
  drep_id: string;
  power: string | null;
  power_prev: string | null;
  delegators: number | null;
  delegators_prev: number | null;
}

export interface DrepStatsDigestResult {
  /** User accounts with a linked DRep and a current-epoch snapshot. */
  candidates: number;
  /** Notification rows actually inserted this pass (conflicts excluded). */
  fired: number;
}

// 6 binds per row, so 16 rows keep a statement at 96 parameters, under D1's
// 100-bind cap (miniflare does not enforce it, size for the real database).
const INSERT_CHUNK = 16;

/**
 * Evaluates the digest for the given epoch and inserts one notification per
 * firing DRep-linked user. Safe to call repeatedly for the same epoch, the
 * event_key conflict target makes re-runs no-ops. `nowMs` is unix
 * MILLISECONDS (the notifications.created_at unit).
 */
export async function runDrepStatsDigest(
  db: D1Database,
  epoch: number,
  nowMs: number,
): Promise<DrepStatsDigestResult> {
  const rows =
    (
      await db
        .prepare(
          `SELECT u.id AS user_id, u.drep_id AS drep_id,
                  cur.amount AS power, prev.amount AS power_prev,
                  cur.delegator_count AS delegators, prev.delegator_count AS delegators_prev
             FROM users u
             JOIN drep_voting_power_history cur
               ON cur.drep_id = u.drep_id AND cur.epoch = ?1
             LEFT JOIN drep_voting_power_history prev
               ON prev.drep_id = u.drep_id AND prev.epoch = ?1 - 1
            WHERE u.drep_id IS NOT NULL AND u.is_drep = 1 AND u.status = 'active'
              AND cur.delegator_count IS NOT NULL`,
        )
        .bind(epoch)
        .all<CandidateRow>()
    ).results ?? [];

  const firing = rows.filter(
    (r) =>
      evaluateDrepStats({
        power: r.power,
        powerPrev: r.power_prev,
        delegators: r.delegators,
        delegatorsPrev: r.delegators_prev,
      }).fires,
  );
  if (firing.length === 0) return { candidates: rows.length, fired: 0 };

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < firing.length; i += INSERT_CHUNK) {
    const chunk = firing.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    stmts.push(
      db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
           VALUES ${values}
           ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        )
        .bind(
          ...chunk.flatMap((r) => [
            crypto.randomUUID(),
            r.user_id,
            'drep_stats',
            `drep_stats:${r.drep_id}:${epoch}`,
            JSON.stringify({
              epoch,
              drepId: r.drep_id,
              power: r.power,
              powerPrev: r.power_prev,
              delegators: r.delegators,
              delegatorsPrev: r.delegators_prev,
            }),
            nowMs,
          ]),
        ),
    );
  }
  const results = await db.batch(stmts);
  const fired = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  return { candidates: rows.length, fired };
}
