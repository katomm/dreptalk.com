/// <reference types="@cloudflare/workers-types" />
// Active participants over a fixed window, measured by users.last_seen (usage,
// not just login). Powers the "active in the last 30 days" summary on the home,
// index and discussions pages. Delegators are aggregated only. Reserved accounts
// (system, gov-sync) and disabled accounts are excluded everywhere. last_seen >
// cutoff is strict: a value exactly at the cutoff is not active.

import { GOV_SYNC_AUTHOR } from '../governance/sync.js';

const SYSTEM_USER_ID = 'system';

export interface ActiveRoleCounts {
  /** Distinct gov-actor rows (a dual DRep+SPO counted once): drives "+N more". */
  actors: number;
  dreps: number;
  spos: number;
  delegators: number;
}

export interface GovFaceRow {
  id: string;
  lastSeen: number;
  isDrep: boolean;
  isSpo: boolean;
  /** DRep voting power in lovelace (string), null for non-DReps or unsynced. */
  votingPower: string | null;
  /** DRep delegator count, null for non-DReps or unsynced. */
  delegatorCount: number | null;
  /** SPO pool ticker, null for non-SPOs or unsynced. */
  poolTicker: string | null;
}

/**
 * Ordered DReps/SPOs seen within the window (newest first, id as the stable
 * tie-break, limit clamped to [1, 50]) with the per-face stats the hover card
 * needs: last seen, and the role headline (DRep voting power + delegator count,
 * SPO ticker). One users query with left joins to dreps/pools. Callers hydrate
 * names/avatars separately via loadAuthorIdentities using the returned ids.
 */
export async function listActiveGovFaces(db: D1Database, cutoffMs: number, limit: number): Promise<GovFaceRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 0, 1), 50);
  const rows = (
    await db
      .prepare(
        `SELECT u.id AS id, u.last_seen AS last_seen, u.is_drep AS is_drep, u.is_spo AS is_spo,
                d.voting_power AS voting_power, d.delegator_count AS delegator_count,
                p.ticker AS pool_ticker
         FROM users u
         LEFT JOIN dreps d ON d.drep_id = u.drep_id
         LEFT JOIN pools p ON p.pool_id = u.pool_id
         WHERE (u.is_drep = 1 OR u.is_spo = 1)
           AND u.status = 'active'
           AND u.last_seen > ?
           AND u.id NOT IN (?, ?)
         ORDER BY u.last_seen DESC, u.id ASC
         LIMIT ?`,
      )
      .bind(cutoffMs, SYSTEM_USER_ID, GOV_SYNC_AUTHOR, n)
      .all<{
        id: string;
        last_seen: number;
        is_drep: number;
        is_spo: number;
        voting_power: string | null;
        delegator_count: number | null;
        pool_ticker: string | null;
      }>()
  ).results ?? [];
  return rows.map((r) => ({
    id: r.id,
    lastSeen: r.last_seen,
    isDrep: r.is_drep === 1,
    isSpo: r.is_spo === 1,
    votingPower: r.voting_power ?? null,
    delegatorCount: r.delegator_count ?? null,
    poolTicker: r.pool_ticker ?? null,
  }));
}

/**
 * Counts active gov actors (distinct rows), DReps, SPOs (a dual-role account
 * counts in dreps and spos both, once in actors), and pure delegators (a
 * delegator_follows row and no governance role) within the window.
 */
export async function countActiveByRole(db: D1Database, cutoffMs: number): Promise<ActiveRoleCounts> {
  const govP = db
    .prepare(
      `SELECT
         COUNT(*) AS actors,
         SUM(CASE WHEN is_drep = 1 THEN 1 ELSE 0 END) AS dreps,
         SUM(CASE WHEN is_spo  = 1 THEN 1 ELSE 0 END) AS spos
       FROM users
       WHERE status = 'active'
         AND last_seen > ?
         AND (is_drep = 1 OR is_spo = 1)
         AND id NOT IN (?, ?)`,
    )
    .bind(cutoffMs, SYSTEM_USER_ID, GOV_SYNC_AUTHOR)
    .first<{ actors: number | null; dreps: number | null; spos: number | null }>();

  const delP = db
    .prepare(
      `SELECT COUNT(*) AS delegators
       FROM users u
       JOIN delegator_follows df ON df.user_id = u.id
       WHERE u.status = 'active'
         AND u.last_seen > ?
         AND u.is_drep = 0 AND u.is_spo = 0 AND u.is_cc = 0 AND u.is_proposer = 0
         AND u.id NOT IN (?, ?)`,
    )
    .bind(cutoffMs, SYSTEM_USER_ID, GOV_SYNC_AUTHOR)
    .first<{ delegators: number }>();

  const [gov, del] = await Promise.all([govP, delP]);
  return {
    actors: gov?.actors ?? 0,
    dreps: gov?.dreps ?? 0,
    spos: gov?.spos ?? 0,
    delegators: del?.delegators ?? 0,
  };
}
