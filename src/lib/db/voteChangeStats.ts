/// <reference types="@cloudflare/workers-types" />
// Network-level vote-change reads for the analytics hub. One row per DRep
// voter with archived history and a live current vote, on decided actions
// whose full history has been swept. The first recorded vote comes from the
// earliest archived block_time. History without a live current vote (possible
// for sweep-sourced archives) is excluded here and surfaced separately via
// countVoteChangeCoverage so the hub can disclose it.
import { liveVoteSql } from './drepVotes.js';

export interface VoteChangeRow {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  decidedEpoch: number;
  firstVote: string;
  currentVote: string;
}

export async function listDecidedVoteChangeRows(db: D1Database): Promise<VoteChangeRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT h.ga_id, g.title, t.slug AS topic_slug, g.type, g.decided_epoch,
                (SELECT h2.vote FROM drep_vote_history h2
                  WHERE h2.ga_id = h.ga_id AND h2.voter_id = h.voter_id
                  ORDER BY h2.block_time ASC LIMIT 1) AS first_vote,
                v.vote AS current_vote
           FROM drep_vote_history h
           JOIN governance_actions g
             ON g.id = h.ga_id AND g.decided_epoch IS NOT NULL AND g.vote_history_swept_at IS NOT NULL
           LEFT JOIN topics t ON t.id = g.topic_id
           JOIN drep_votes v
             ON v.ga_id = h.ga_id AND v.voter_id = h.voter_id AND ${liveVoteSql('v')}
          WHERE h.voter_role = 'DRep'
          GROUP BY h.ga_id, h.voter_id`,
      )
      .all<{ ga_id: string; title: string | null; topic_slug: string | null; type: string; decided_epoch: number; first_vote: string; current_vote: string }>()
  ).results ?? [];
  return rows.map((r) => ({
    gaId: r.ga_id,
    title: r.title,
    topicSlug: r.topic_slug,
    type: r.type,
    decidedEpoch: r.decided_epoch,
    firstVote: r.first_vote,
    currentVote: r.current_vote,
  }));
}

export async function countVoteChangeCoverage(
  db: D1Database,
): Promise<{ decidedSwept: number; decidedUnswept: number; orphanPairs: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM governance_actions WHERE decided_epoch IS NOT NULL AND vote_history_swept_at IS NOT NULL) AS decided_swept,
         (SELECT COUNT(*) FROM governance_actions WHERE decided_epoch IS NOT NULL AND vote_history_swept_at IS NULL) AS decided_unswept,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM drep_vote_history h
             JOIN governance_actions g
               ON g.id = h.ga_id AND g.decided_epoch IS NOT NULL AND g.vote_history_swept_at IS NOT NULL
            WHERE h.voter_role = 'DRep'
              AND NOT EXISTS (SELECT 1 FROM drep_votes v
                               WHERE v.ga_id = h.ga_id AND v.voter_id = h.voter_id AND ${liveVoteSql('v')})
            GROUP BY h.ga_id, h.voter_id)) AS orphan_pairs`,
    )
    .first<{ decided_swept: number; decided_unswept: number; orphan_pairs: number }>();
  return {
    decidedSwept: row?.decided_swept ?? 0,
    decidedUnswept: row?.decided_unswept ?? 0,
    orphanPairs: row?.orphan_pairs ?? 0,
  };
}
