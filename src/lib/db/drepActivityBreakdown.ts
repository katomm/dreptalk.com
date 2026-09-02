/// <reference types="@cloudflare/workers-types" />
// Network-wide DRep activity layers for the analytics hub. Representative
// layer only: the special auto-voting ids are excluded in every query.
// "everVoted" counts distinct DReps with any on-chain vote, superseded votes
// included, so a DRep whose only vote was later changed still counts as
// having voted. The inactive stake is summed as BigInt because lovelace
// totals exceed Number's exact-integer range.
import { drepPath } from '../dreps/profile.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';
import { pct4 } from '../format/pct.js';

export interface InactiveDrepRow {
  drepId: string;
  name: string | null;
  href: string;
  /** Lovelace string, exact. */
  votingPower: string;
  /** Deregistered on chain, as opposed to a registration that lapsed into inactivity. */
  retired: boolean;
}

/** How many of the largest inactive DReps the breakdown lists by name. */
export const TOP_INACTIVE_LIMIT = 5;
/** How many of the largest holders the concentration share is read over. */
const TOP_SHARE_LIMIT = 10;

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
  /** The largest inactive DReps by stake, descending, holders of nothing left out. */
  topInactive: InactiveDrepRow[];
  /** Share of the inactive stake held by its ten largest holders, null when there is none. */
  top10InactiveSharePct: number | null;
}

const SPECIAL_PLACEHOLDERS = SPECIAL_DREP_IDS.map(() => '?').join(', ');

export async function getDrepActivityBreakdown(db: D1Database): Promise<DrepActivityBreakdown> {
  // One round-trip for the three reads. The inactive stake rows are read
  // largest first so the head of the list is the top-ten share and the
  // BigInt sum below still covers every row, and only the few named rows
  // carry the profile columns.
  const [countsRes, votedRes, inactiveRes, topRes] = await db.batch([
    db
      .prepare(
        `SELECT
           COUNT(*) AS registered,
           SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN active = 1 AND CAST(voting_power AS INTEGER) > 0 THEN 1 ELSE 0 END) AS powered,
           SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS inactive
         FROM dreps WHERE drep_id NOT IN (${SPECIAL_PLACEHOLDERS})`,
      )
      .bind(...SPECIAL_DREP_IDS),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT voter_id FROM drep_votes
            WHERE voter_role = 'DRep' AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
           UNION
           SELECT voter_id FROM drep_vote_history
            WHERE voter_role = 'DRep' AND voter_id NOT IN (${SPECIAL_PLACEHOLDERS})
         )`,
      )
      .bind(...SPECIAL_DREP_IDS, ...SPECIAL_DREP_IDS),
    db
      .prepare(
        `SELECT voting_power FROM dreps
          WHERE active = 0 AND voting_power IS NOT NULL AND drep_id NOT IN (${SPECIAL_PLACEHOLDERS})
          ORDER BY CAST(voting_power AS INTEGER) DESC`,
      )
      .bind(...SPECIAL_DREP_IDS),
    db
      .prepare(
        `SELECT drep_id, name, slug, status, voting_power FROM dreps
          WHERE active = 0 AND CAST(voting_power AS INTEGER) > 0 AND drep_id NOT IN (${SPECIAL_PLACEHOLDERS})
          ORDER BY CAST(voting_power AS INTEGER) DESC
          LIMIT ?`,
      )
      .bind(...SPECIAL_DREP_IDS, TOP_INACTIVE_LIMIT),
  ]);
  const counts = (countsRes.results as { registered: number; active: number | null; powered: number | null; inactive: number | null }[])[0];
  const voted = (votedRes.results as { n: number }[])[0];
  const inactiveRows = inactiveRes.results as { voting_power: string }[];
  const topRows = topRes.results as { drep_id: string; name: string | null; slug: string | null; status: string; voting_power: string }[];

  let inactiveStake = 0n;
  let topShare = 0n;
  let accepted = 0;
  for (const r of inactiveRows) {
    let power: bigint;
    try {
      power = BigInt(r.voting_power);
    } catch {
      // A malformed stored value must not take the page down, skip it.
      continue;
    }
    inactiveStake += power;
    if (accepted < TOP_SHARE_LIMIT) topShare += power;
    accepted += 1;
  }

  return {
    registered: counts?.registered ?? 0,
    active: counts?.active ?? 0,
    powered: counts?.powered ?? 0,
    everVoted: voted?.n ?? 0,
    inactiveCount: counts?.inactive ?? 0,
    inactiveStake: inactiveStake.toString(),
    topInactive: topRows.map((r) => ({
      drepId: r.drep_id,
      name: r.name,
      href: drepPath({ drepId: r.drep_id, slug: r.slug }),
      votingPower: r.voting_power,
      retired: r.status === 'deregistered',
    })),
    top10InactiveSharePct: inactiveStake > 0n ? pct4(topShare, inactiveStake) : null,
  };
}
