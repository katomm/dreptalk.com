/// <reference types="@cloudflare/workers-types" />
// Network-wide DRep activity layers for the analytics hub. Representative
// layer only: the special auto-voting ids are excluded in every query.
// "everVoted" counts distinct DReps with any on-chain vote, superseded votes
// included, so a DRep whose only vote was later changed still counts as
// having voted. The inactive stake is summed as BigInt because lovelace
// totals exceed Number's exact-integer range.
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

export interface DrepActivityBreakdown {
  /** Non-special rows in dreps (any status). */
  registered: number;
  /** active = 1 rows. */
  active: number;
  /** active = 1 rows with voting power above zero. */
  powered: number;
  /** Distinct non-special DReps with at least one on-chain vote ever. */
  everVoted: number;
  /** active = 0 rows. */
  inactiveCount: number;
  /** Lovelace still delegated to active = 0 DReps, exact BigInt sum as string. */
  inactiveStake: string;
}

const SPECIAL_PLACEHOLDERS = SPECIAL_DREP_IDS.map(() => '?').join(', ');

export async function getDrepActivityBreakdown(db: D1Database): Promise<DrepActivityBreakdown> {
  const counts = await db
    .prepare(
      `SELECT
         COUNT(*) AS registered,
         SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN active = 1 AND CAST(voting_power AS INTEGER) > 0 THEN 1 ELSE 0 END) AS powered,
         SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS inactive
       FROM dreps WHERE drep_id NOT IN (${SPECIAL_PLACEHOLDERS})`,
    )
    .bind(...SPECIAL_DREP_IDS)
    .first<{ registered: number; active: number | null; powered: number | null; inactive: number | null }>();

  const voted = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT voter_id FROM drep_votes
          WHERE voter_role = 'DRep' AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
         UNION
         SELECT voter_id FROM drep_vote_history
          WHERE voter_role = 'DRep' AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
       )`,
    )
    .bind(...SPECIAL_DREP_IDS, ...SPECIAL_DREP_IDS)
    .first<{ n: number }>();

  const inactiveRows = (
    await db
      .prepare(
        `SELECT voting_power FROM dreps
          WHERE active = 0 AND voting_power IS NOT NULL AND drep_id NOT IN (${SPECIAL_PLACEHOLDERS})`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ voting_power: string }>()
  ).results ?? [];
  let inactiveStake = 0n;
  for (const r of inactiveRows) {
    try {
      inactiveStake += BigInt(r.voting_power);
    } catch {
      // A malformed stored value must not take the page down, skip it.
    }
  }

  return {
    registered: counts?.registered ?? 0,
    active: counts?.active ?? 0,
    powered: counts?.powered ?? 0,
    everVoted: voted?.n ?? 0,
    inactiveCount: counts?.inactive ?? 0,
    inactiveStake: inactiveStake.toString(),
  };
}
