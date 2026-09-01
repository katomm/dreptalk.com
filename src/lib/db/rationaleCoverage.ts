/// <reference types="@cloudflare/workers-types" />
// Rationale-coverage reads for the analytics hub. A rationale here is the
// vote's metadata anchor (meta_url non-empty). The per-DRep stats read the
// same anchor, but the positions tab counts fetched documents, which can be
// fewer when an anchor is dead. Power sums travel as TEXT: SQLite sums are
// exact in 64-bit integers, but D1's JS bridge would round numbers above
// 2^53, and cross-action totals cross that line. Sums are NULL whenever any
// live vote lacks a power reading, a partial power sum must never pose as a
// total.
import { liveVoteSql } from './drepVotes.js';

export interface ActionRationaleCoverage {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  decidedEpoch: number;
  votes: number;
  withRationale: number;
  votesWithPower: number;
  power: string | null;
  powerWithRationale: string | null;
}

export async function listDecidedActionRationaleCoverage(
  db: D1Database,
): Promise<ActionRationaleCoverage[]> {
  const rows = (
    await db
      .prepare(
        `SELECT g.id, g.title, t.slug AS topic_slug, g.type, g.decided_epoch,
                COUNT(v.voter_id) AS votes,
                SUM(CASE WHEN v.meta_url IS NOT NULL AND v.meta_url != '' THEN 1 ELSE 0 END) AS with_rationale,
                SUM(CASE WHEN v.voted_power IS NOT NULL THEN 1 ELSE 0 END) AS votes_with_power,
                CAST(SUM(v.voted_power) AS TEXT) AS power,
                CAST(SUM(CASE WHEN v.meta_url IS NOT NULL AND v.meta_url != '' THEN v.voted_power ELSE 0 END) AS TEXT) AS power_with_rationale
           FROM governance_actions g
           LEFT JOIN topics t ON t.id = g.topic_id
           JOIN drep_votes v ON v.ga_id = g.id AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
          WHERE g.decided_epoch IS NOT NULL
          GROUP BY g.id`,
      )
      .all<{ id: string; title: string | null; topic_slug: string | null; type: string; decided_epoch: number; votes: number; with_rationale: number; votes_with_power: number; power: string | null; power_with_rationale: string | null }>()
  ).results ?? [];
  return rows.map((r) => {
    const complete = r.votes > 0 && r.votes_with_power === r.votes;
    return {
      gaId: r.id,
      title: r.title,
      topicSlug: r.topic_slug,
      type: r.type,
      decidedEpoch: r.decided_epoch,
      votes: r.votes,
      withRationale: r.with_rationale,
      votesWithPower: r.votes_with_power,
      power: complete ? r.power : null,
      powerWithRationale: complete ? r.power_with_rationale : null,
    };
  });
}

/**
 * Distinct (action, voter) pairs on decided actions where the voter's EARLIEST
 * archived vote carried no anchor and the live current vote carries one, the
 * rationale arrived through a re-vote. The earliest row is the baseline on
 * purpose, a voter can toggle anchors across several re-votes.
 */
export async function countRationaleAddedViaRevote(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT h.ga_id, h.voter_id
           FROM drep_vote_history h
           JOIN governance_actions g ON g.id = h.ga_id AND g.decided_epoch IS NOT NULL
           JOIN drep_votes v ON v.ga_id = h.ga_id AND v.voter_id = h.voter_id AND ${liveVoteSql('v')}
          WHERE h.voter_role = 'DRep'
            AND v.meta_url IS NOT NULL AND v.meta_url != ''
          GROUP BY h.ga_id, h.voter_id
         HAVING (SELECT h2.meta_url IS NOT NULL AND h2.meta_url != ''
                   FROM drep_vote_history h2
                  WHERE h2.ga_id = h.ga_id AND h2.voter_id = h.voter_id
                  ORDER BY h2.block_time ASC LIMIT 1) = 0)`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}
