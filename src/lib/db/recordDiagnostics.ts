/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 reads for the private DRep diagnostics page: eligible actions
// the DRep never voted on, own votes missing a rationale anchor, the cohort's
// report-card values (for a histogram), and vote-timing (own vs network) by
// action type. Read-only, no writes.
import { liveVoteSql } from './drepVotes.js';

export interface UnvotedAction {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  decidedEpoch: number;
}

export interface UnrationaledVote {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  vote: string;
  decidedEpoch: number | null;
}

export interface CohortValues {
  participationPct: number;
  rationalePct: number | null;
}

export interface NetworkTypeTiming {
  type: string;
  medianDay: number;
  timedVotes: number;
}

export interface OwnVoteTiming {
  type: string;
  blockTime: number;
  submittedAt: number;
  decidedEpoch: number | null;
  expiryEpoch: number | null;
}

const DEFAULT_LIMIT = 50;

/**
 * Decided actions the DRep was eligible to vote on but did not: the same
 * eligible set as getDrepParticipation (decided_epoch >= registeredEpoch, at
 * least one live DRep vote exists on the action, the EXISTS clause mirrored
 * verbatim), minus the ones where this DRep itself has a live vote. Newest
 * first (decided_epoch DESC, id ASC as tiebreaker).
 */
export async function listUnvotedEligibleActions(
  db: D1Database,
  drepId: string,
  registeredEpoch: number,
  limit = DEFAULT_LIMIT,
): Promise<{ rows: UnvotedAction[]; total: number }> {
  const predicate = `
    g.decided_epoch IS NOT NULL
    AND g.decided_epoch >= ?
    AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep'
                  AND ${liveVoteSql('dv')})
    AND NOT EXISTS (SELECT 1 FROM drep_votes v WHERE v.ga_id = g.id AND v.voter_id = ? AND v.voter_role = 'DRep'
                      AND ${liveVoteSql('v')})
  `;
  const [pageRes, countRow] = await Promise.all([
    db
      .prepare(
        `SELECT g.id AS gaId, g.title AS title, t.slug AS topicSlug, g.type AS type, g.decided_epoch AS decidedEpoch
         FROM governance_actions g
         LEFT JOIN topics t ON t.id = g.topic_id
         WHERE ${predicate}
         ORDER BY g.decided_epoch DESC, g.id ASC
         LIMIT ?`,
      )
      .bind(registeredEpoch, drepId, limit)
      .all<UnvotedAction>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM governance_actions g WHERE ${predicate}`)
      .bind(registeredEpoch, drepId)
      .first<{ n: number }>(),
  ]);
  return { rows: pageRes.results ?? [], total: countRow?.n ?? 0 };
}

/**
 * This DRep's own live votes carrying no rationale anchor (meta_url NULL or
 * empty), joined to the action (and its topic, for linking). Open actions
 * (decidedEpoch null) sort first, then decided actions newest first: SQLite
 * orders `decided_epoch IS NOT NULL` (0 for open, 1 for decided) ascending,
 * so open rows lead, then ties break on decided_epoch DESC.
 */
export async function listUnrationaledVotes(
  db: D1Database,
  drepId: string,
  limit = DEFAULT_LIMIT,
): Promise<{ rows: UnrationaledVote[]; total: number }> {
  const predicate = `v.voter_id = ? AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
    AND (v.meta_url IS NULL OR v.meta_url = '')`;
  const [pageRes, countRow] = await Promise.all([
    db
      .prepare(
        `SELECT v.ga_id AS gaId, g.title AS title, t.slug AS topicSlug, g.type AS type, v.vote AS vote,
                g.decided_epoch AS decidedEpoch
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         LEFT JOIN topics t ON t.id = g.topic_id
         WHERE ${predicate}
         ORDER BY g.decided_epoch IS NOT NULL, g.decided_epoch DESC, g.id ASC
         LIMIT ?`,
      )
      .bind(drepId, limit)
      .all<UnrationaledVote>(),
    db.prepare(`SELECT COUNT(*) AS n FROM drep_votes v WHERE ${predicate}`).bind(drepId).first<{ n: number }>(),
  ]);
  return { rows: pageRes.results ?? [], total: countRow?.n ?? 0 };
}

/**
 * Every cohort member's report-card values (drep_report_card), for the
 * diagnostics page's cohort histograms. One row per cohort member, no
 * filtering: the table only ever holds current cohort rows (replaceReportCards
 * swaps it atomically each sync).
 */
export async function listCohortValues(db: D1Database): Promise<CohortValues[]> {
  return (
    await db
      .prepare('SELECT participation_pct AS participationPct, rationale_pct AS rationalePct FROM drep_report_card')
      .all<CohortValues>()
  ).results ?? [];
}

/**
 * Median vote-timing (days from an action's submission to the vote), per
 * action type, over every live timed DRep vote network-wide. Only rows with
 * both timestamps present and a non-negative delta qualify (submitted_at is
 * milliseconds, block_time is seconds, hence the *1000.0 normalization).
 *
 * The rn-pair median trick: within each type partition, rows are numbered by
 * ROW_NUMBER() over the sorted day deltas (rn), alongside the partition's row
 * count (n). Keeping only rn IN ((n+1)/2, (n+2)/2) uses SQLite's integer
 * division to collapse that pair to the single middle row when n is odd (both
 * halves land on the same rn), and to the two true middle rows when n is even.
 * AVG(day) over the kept rows is therefore exactly the median for both parities.
 */
export async function getNetworkTimingByType(db: D1Database): Promise<NetworkTypeTiming[]> {
  const rows = (
    await db
      .prepare(
        `WITH t AS (
           SELECT g.type, (v.block_time * 1000.0 - g.submitted_at) / 86400000.0 AS day,
                  ROW_NUMBER() OVER (PARTITION BY g.type ORDER BY (v.block_time * 1000.0 - g.submitted_at)) AS rn,
                  COUNT(*) OVER (PARTITION BY g.type) AS n
             FROM drep_votes v
             JOIN governance_actions g ON g.id = v.ga_id
            WHERE v.voter_role = 'DRep' AND ${liveVoteSql('v')}
              AND v.block_time IS NOT NULL AND g.submitted_at IS NOT NULL
              AND v.block_time * 1000.0 >= g.submitted_at
         )
         SELECT type, AVG(day) AS median_day, MAX(n) AS timed_votes
           FROM t WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY type ORDER BY type`,
      )
      .all<{ type: string; median_day: number; timed_votes: number }>()
  ).results ?? [];
  return rows.map((r) => ({ type: r.type, medianDay: r.median_day, timedVotes: r.timed_votes }));
}

/**
 * This DRep's own live timed votes (both block_time and submitted_at present),
 * with the action's type and decided/expiry epochs, for the own-vs-network
 * timing comparison and the early/middle/late window classification (done in
 * the view layer, which needs the epochs to compute the voting window).
 */
export async function listOwnVoteTimings(db: D1Database, drepId: string): Promise<OwnVoteTiming[]> {
  return (
    await db
      .prepare(
        `SELECT g.type AS type, v.block_time AS blockTime, g.submitted_at AS submittedAt,
                g.decided_epoch AS decidedEpoch, g.expiry_epoch AS expiryEpoch
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         WHERE v.voter_id = ? AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
           AND v.block_time IS NOT NULL AND g.submitted_at IS NOT NULL`,
      )
      .bind(drepId)
      .all<OwnVoteTiming>()
  ).results ?? [];
}
