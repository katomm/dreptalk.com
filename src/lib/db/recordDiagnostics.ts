/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 reads for the private DRep diagnostics page: eligible actions
// the DRep never voted on, own votes missing a rationale anchor, the cohort's
// report-card values (for a histogram), and vote-timing (own vs network) by
// action type. Also count-based network-wide timing reads (overall median,
// half-turnout day, early/middle/late window buckets) for a public panel.
// Read-only, no writes.
import { liveVoteSql } from './drepVotes.js';
import { EPOCH_LENGTH_SECONDS } from '@/lib/config/network.js';

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

export interface NetworkOverallTiming {
  medianDay: number;
  timedVotes: number;
}

export interface WindowThirds {
  early: number;
  middle: number;
  late: number;
  afterClose: number;
  basis: number;
}

export interface OwnVoteTiming {
  type: string;
  blockTime: number;
  submittedAt: number;
  decidedEpoch: number | null;
  expiryEpoch: number | null;
  status: string;
}

const DEFAULT_LIMIT = 50;

// Shared by every network-wide timing read: an open action can only hold early
// votes so far (it has not reached its window end yet), so including it would
// bias the "how long after submission" figures early. Restricting to decided
// actions keeps these medians comparable to the decided-only thirds bucketing.
const DECIDED_STATUS_SQL = "g.status IN ('enacted', 'ratified', 'expired', 'closed')";

// Shared by the timing reads that measure days from submission: both sides of
// the delta have to be on record and the vote must not predate the submission
// (submitted_at is milliseconds, block_time is seconds, hence the *1000.0).
const TIMED_VOTE_SQL =
  'v.block_time IS NOT NULL AND g.submitted_at IS NOT NULL AND v.block_time * 1000.0 >= g.submitted_at';

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
 * action type, over every live timed vote on a decided action, network-wide,
 * for the given voter role (DRep by default, kept for the record page's
 * existing callers). Decided actions only: an open action can only hold early
 * votes so far, so including it would bias the median toward the early side.
 * Only rows with both timestamps present and a non-negative delta qualify
 * (submitted_at is milliseconds, block_time is seconds, hence the *1000.0
 * normalization).
 *
 * The rn-pair median trick: within each type partition, rows are numbered by
 * ROW_NUMBER() over the sorted day deltas (rn), alongside the partition's row
 * count (n). Keeping only rn IN ((n+1)/2, (n+2)/2) uses SQLite's integer
 * division to collapse that pair to the single middle row when n is odd (both
 * halves land on the same rn), and to the two true middle rows when n is even.
 * AVG(day) over the kept rows is therefore exactly the median for both parities.
 */
export async function getNetworkTimingByType(db: D1Database, role: 'DRep' | 'SPO' = 'DRep'): Promise<NetworkTypeTiming[]> {
  const rows = (
    await db
      .prepare(
        `WITH t AS (
           SELECT g.type, (v.block_time * 1000.0 - g.submitted_at) / 86400000.0 AS day,
                  ROW_NUMBER() OVER (PARTITION BY g.type ORDER BY (v.block_time * 1000.0 - g.submitted_at)) AS rn,
                  COUNT(*) OVER (PARTITION BY g.type) AS n
             FROM drep_votes v
             JOIN governance_actions g ON g.id = v.ga_id
            WHERE v.voter_role = ? AND ${liveVoteSql('v')}
              AND ${DECIDED_STATUS_SQL}
              AND ${TIMED_VOTE_SQL}
         )
         SELECT type, AVG(day) AS median_day, MAX(n) AS timed_votes
           FROM t WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY type ORDER BY type`,
      )
      .bind(role)
      .all<{ type: string; median_day: number; timed_votes: number }>()
  ).results ?? [];
  return rows.map((r) => ({ type: r.type, medianDay: r.median_day, timedVotes: r.timed_votes }));
}

/**
 * Same rn-pair median trick as getNetworkTimingByType, but without the type
 * partition: one overall median across every live timed vote on a decided
 * action, network-wide, for the given voter role. Decided actions only, same
 * reasoning as getNetworkTimingByType: an open action can only hold early
 * votes so far. Null when the role has no timed votes at all.
 */
export async function getNetworkTimingOverall(db: D1Database, role: 'DRep' | 'SPO'): Promise<NetworkOverallTiming | null> {
  const row = await db
    .prepare(
      `WITH t AS (
         SELECT (v.block_time * 1000.0 - g.submitted_at) / 86400000.0 AS day,
                ROW_NUMBER() OVER (ORDER BY (v.block_time * 1000.0 - g.submitted_at)) AS rn,
                COUNT(*) OVER () AS n
           FROM drep_votes v
           JOIN governance_actions g ON g.id = v.ga_id
          WHERE v.voter_role = ? AND ${liveVoteSql('v')}
            AND ${DECIDED_STATUS_SQL}
            AND ${TIMED_VOTE_SQL}
       )
       SELECT AVG(day) AS median_day, MAX(n) AS timed_votes
         FROM t WHERE rn IN ((n + 1) / 2, (n + 2) / 2)`,
    )
    .bind(role)
    .first<{ median_day: number | null; timed_votes: number | null }>();
  if (!row || row.median_day === null || row.timed_votes === null) return null;
  return { medianDay: row.median_day, timedVotes: row.timed_votes };
}

/**
 * Half-turnout day per decided action: for every decided action with at
 * least two live timed DRep votes, the day (from submission) of the vote at
 * rn = (n+1)/2 (SQLite integer division), i.e. the ceil(n/2)-th vote by
 * block_time. That is the point at which half the action's timed turnout had
 * voted. Returns the raw day values, the caller computes the median across
 * actions.
 *
 * The status filter excludes 'dropped': tallySync also sets decided_epoch on
 * a dropped action, so decided_epoch IS NOT NULL alone is not a safe proxy
 * for "voting concluded normally". A dropped action's votes must not leak
 * into this public timing figure.
 */
export async function getHalfTurnoutDays(db: D1Database): Promise<number[]> {
  const rows = (
    await db
      .prepare(
        `WITH t AS (
           SELECT (v.block_time * 1000.0 - g.submitted_at) / 86400000.0 AS day,
                  ROW_NUMBER() OVER (PARTITION BY v.ga_id ORDER BY v.block_time) AS rn,
                  COUNT(*) OVER (PARTITION BY v.ga_id) AS n
             FROM drep_votes v
             JOIN governance_actions g ON g.id = v.ga_id
            WHERE v.voter_role = 'DRep' AND ${liveVoteSql('v')}
              AND g.decided_epoch IS NOT NULL
              AND ${DECIDED_STATUS_SQL}
              AND ${TIMED_VOTE_SQL}
         )
         SELECT day FROM t WHERE n >= 2 AND rn = (n + 1) / 2`,
      )
      .all<{ day: number }>()
  ).results ?? [];
  return rows.map((r) => r.day);
}

/**
 * Buckets every live timed DRep vote on a decided action into early/middle/
 * late thirds of its voting window, plus a separate afterClose bucket for
 * votes past the window end (basis excludes afterClose).
 *
 * The window end epoch is decided_end (decided_epoch, minus one for an
 * enacted action, whose decided_epoch is the ENACTMENT epoch one past the
 * ratification epoch where voting stopped mattering) capped by expiry_epoch.
 * The COALESCE stands in for a missing expiry, since SQLite's MIN() returns
 * NULL as soon as one argument is NULL, and decided_end itself is always
 * present because the WHERE clause requires decided_epoch. anchor converts
 * that epoch to milliseconds via the same epoch-start formula as
 * epochStartUnix (unixSeconds + (epoch - anchorEpoch) * EPOCH_LENGTH_SECONDS),
 * inlined here because the conversion has to happen inside the SQL to bucket
 * per row. position is where the vote falls between submission (0) and the
 * window end (1), rows where the window end is at or before submission are
 * skipped as degenerate.
 *
 * The status filter excludes 'dropped', same reasoning as getHalfTurnoutDays:
 * tallySync sets decided_epoch on a dropped action too, so decided_epoch
 * IS NOT NULL alone would let a dropped action's votes into this public
 * bucketing.
 */
export async function getWindowThirds(db: D1Database, anchor: { epoch: number; unixSeconds: number }): Promise<WindowThirds> {
  const row = await db
    .prepare(
      `WITH w AS (
         SELECT v.block_time * 1000.0 AS block_ms, g.submitted_at AS submitted_at,
                g.expiry_epoch AS expiry_epoch,
                CASE WHEN g.status = 'enacted' THEN g.decided_epoch - 1 ELSE g.decided_epoch END AS decided_end
           FROM drep_votes v
           JOIN governance_actions g ON g.id = v.ga_id
          WHERE v.voter_role = 'DRep' AND ${liveVoteSql('v')}
            AND g.decided_epoch IS NOT NULL
            AND ${DECIDED_STATUS_SQL}
            AND v.block_time IS NOT NULL AND g.submitted_at IS NOT NULL
       ), t AS (
         SELECT block_ms, submitted_at,
                (? + (MIN(decided_end, COALESCE(expiry_epoch, decided_end)) - ?) * ${EPOCH_LENGTH_SECONDS}) * 1000.0 AS end_ms
           FROM w
       ), q AS (
         SELECT (block_ms - submitted_at) / (end_ms - submitted_at) AS position
           FROM t WHERE end_ms > submitted_at AND block_ms >= submitted_at
       )
       SELECT
         COALESCE(SUM(CASE WHEN position < 1.0 / 3 THEN 1 ELSE 0 END), 0) AS early,
         COALESCE(SUM(CASE WHEN position >= 1.0 / 3 AND position <= 2.0 / 3 THEN 1 ELSE 0 END), 0) AS middle,
         COALESCE(SUM(CASE WHEN position <= 1.0 AND position > 2.0 / 3 THEN 1 ELSE 0 END), 0) AS late,
         COALESCE(SUM(CASE WHEN position > 1.0 THEN 1 ELSE 0 END), 0) AS afterClose
         FROM q`,
    )
    .bind(anchor.unixSeconds, anchor.epoch)
    .first<{ early: number; middle: number; late: number; afterClose: number }>();
  const early = row?.early ?? 0;
  const middle = row?.middle ?? 0;
  const late = row?.late ?? 0;
  const afterClose = row?.afterClose ?? 0;
  return { early, middle, late, afterClose, basis: early + middle + late };
}

/**
 * This DRep's own live timed votes (both block_time and submitted_at present),
 * with the action's type, decided/expiry epochs, and status, for the
 * own-vs-network timing comparison and the early/middle/late window
 * classification (done in the view layer, which needs the epochs and status
 * to compute the voting window: an enacted action's decided_epoch is the
 * enactment epoch, one past ratification, same as getWindowThirds).
 */
export async function listOwnVoteTimings(db: D1Database, drepId: string): Promise<OwnVoteTiming[]> {
  return (
    await db
      .prepare(
        `SELECT g.type AS type, v.block_time AS blockTime, g.submitted_at AS submittedAt,
                g.decided_epoch AS decidedEpoch, g.expiry_epoch AS expiryEpoch, g.status AS status
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         WHERE v.voter_id = ? AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
           AND v.block_time IS NOT NULL AND g.submitted_at IS NOT NULL`,
      )
      .bind(drepId)
      .all<OwnVoteTiming>()
  ).results ?? [];
}
