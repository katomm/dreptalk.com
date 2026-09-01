/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 reads for the delegator-gated "My DRep" page: what the DRep
// a user delegated to has done since that delegation started, plus the last
// decided actions a default-option delegator's stake was applied to.
// Read-only, no writes.
import { liveVoteSql } from './drepVotes.js';

export interface SinceActionRow {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  decidedEpoch: number;
  status: string;
  /** The DRep's own live vote on the action, null when it did not vote. */
  vote: string | null;
  /** Whether the DRep's vote carries a rendered rationale (action_rationale status 'ok'). */
  hasRationale: boolean;
}

/** One epoch snapshot of a DRep's voting power and delegator headcount. */
export interface PowerPoint {
  epoch: number;
  /** Lovelace as an exact string, past Number's safe-integer range. */
  amount: string;
  /** NULL for epochs captured before the headcount stamp existed. */
  delegatorCount: number | null;
}

export interface RecentDecidedAction {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  status: string;
  decidedEpoch: number;
}

// Mirrors DECIDED_STATUS_SQL in recordDiagnostics.ts. A dropped action carries a
// decided_epoch too, but it never reached a vote outcome, so it is not a decision
// anyone could have participated in and stays out of every figure here.
const DECIDED_STATUS_SQL = "g.status IN ('enacted', 'ratified', 'expired', 'closed')";

// Runaway guard for the M2 list, which asks for ten rows.
const MAX_RECENT = 100;

/**
 * The decided actions the DRep was eligible to vote on since the delegation
 * started, each with the DRep's own vote (null when it did not vote) and whether
 * that vote carries a rendered rationale.
 *
 * The eligible set mirrors getDrepParticipation: decided_epoch >= the given
 * epoch and at least one live DRep vote exists on the action (an action no DRep
 * could vote on was never DRep-votable, so it belongs in no denominator). On top
 * of that it applies the decided-status filter, so the since-figures count
 * decisions only. That makes them a strict subset of the profile's all-time
 * participation, which counts dropped actions too.
 *
 * Newest first (decided_epoch DESC, id ASC as tiebreaker), matching the other
 * action lists on the site.
 */
export async function listDrepActionsSince(
  db: D1Database,
  drepId: string,
  sinceEpoch: number,
): Promise<SinceActionRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT g.id AS gaId, g.title AS title, t.slug AS topicSlug, g.type AS type,
                g.decided_epoch AS decidedEpoch, g.status AS status, v.vote AS vote,
                CASE WHEN r.status = 'ok' THEN 1 ELSE 0 END AS hasRationale
           FROM governance_actions g
           LEFT JOIN topics t ON t.id = g.topic_id
           LEFT JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = ? AND v.voter_role = 'DRep'
                AND ${liveVoteSql('v')}
           LEFT JOIN action_rationale r ON r.ga_id = g.id AND r.voter_id = ?
          WHERE g.decided_epoch IS NOT NULL
            AND g.decided_epoch >= ?
            AND ${DECIDED_STATUS_SQL}
            AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep'
                          AND ${liveVoteSql('dv')})
          ORDER BY g.decided_epoch DESC, g.id ASC`,
      )
      .bind(drepId, drepId, sinceEpoch)
      .all<Omit<SinceActionRow, 'hasRationale'> & { hasRationale: number }>()
  ).results ?? [];
  return rows.map((r) => ({ ...r, hasRationale: r.hasRationale === 1 }));
}

/**
 * How often the DRep superseded one of its own votes since the delegation
 * started. drep_vote_history holds one row per superseded vote, so the count is
 * of changes, not of actions.
 *
 * The window is keyed on superseded_at, when the vote was REPLACED, not on
 * block_time, when the vote it replaced was originally cast. A vote cast long
 * before the delegation started and changed inside the window is a change the
 * delegator lived through, and block_time would drop it. superseded_at holds the
 * replacing vote's block_time for backfilled rows and the sync time that
 * observed the change for live ones, both unix SECONDS, the same unit as
 * `sinceUnix`. The boundary is inclusive.
 */
export async function countVoteChangesSince(
  db: D1Database,
  drepId: string,
  sinceUnix: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM drep_vote_history
        WHERE voter_id = ? AND voter_role = 'DRep' AND superseded_at >= ?`,
    )
    .bind(drepId, sinceUnix)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The DRep's earliest power snapshot at or after the given epoch. The history is
 * a rolling window, so a delegation that started before the retention floor has
 * no row on its own epoch. The caller discloses the returned epoch rather than
 * pretending the figure belongs to the start epoch. Null when the DRep has no
 * snapshot in or after that epoch at all.
 */
export async function getPowerAtOrAfter(
  db: D1Database,
  drepId: string,
  epoch: number,
): Promise<PowerPoint | null> {
  const row = await db
    .prepare(
      `SELECT epoch, amount, delegator_count FROM drep_voting_power_history
        WHERE drep_id = ? AND epoch >= ? ORDER BY epoch ASC LIMIT 1`,
    )
    .bind(drepId, epoch)
    .first<{ epoch: number; amount: string; delegator_count: number | null }>();
  return row ? { epoch: row.epoch, amount: row.amount, delegatorCount: row.delegator_count } : null;
}

/** The DRep's most recent power snapshot, or null when none was ever captured. */
export async function getPowerLatest(db: D1Database, drepId: string): Promise<PowerPoint | null> {
  const row = await db
    .prepare(
      `SELECT epoch, amount, delegator_count FROM drep_voting_power_history
        WHERE drep_id = ? ORDER BY epoch DESC LIMIT 1`,
    )
    .bind(drepId)
    .first<{ epoch: number; amount: string; delegator_count: number | null }>();
  return row ? { epoch: row.epoch, amount: row.amount, delegatorCount: row.delegator_count } : null;
}

/**
 * The most recently decided governance actions, newest first (decided_epoch
 * DESC, id ASC as tiebreaker). Same decided-status filter as the read above, so
 * a default-option delegator sees the decisions their standing choice was
 * applied to and no dropped rows. `limit` is clamped to 1..100.
 *
 * `sinceEpoch` bounds the window below (decided_epoch >= sinceEpoch). A standing
 * default option only applied to actions decided from the delegation start on,
 * so without that bound the list would tell a delegator their stake counted on
 * decisions taken before they made the choice. Omit it only where no start is
 * known, and then say so rather than labelling effects.
 */
export async function listRecentDecidedActions(
  db: D1Database,
  limit: number,
  sinceEpoch?: number,
): Promise<RecentDecidedAction[]> {
  const capped = Math.min(Math.max(limit, 1), MAX_RECENT);
  const bounded = sinceEpoch != null;
  const rows = (
    await db
      .prepare(
        `SELECT g.id AS gaId, g.title AS title, t.slug AS topicSlug, g.type AS type,
                g.status AS status, g.decided_epoch AS decidedEpoch
           FROM governance_actions g
           LEFT JOIN topics t ON t.id = g.topic_id
          WHERE g.decided_epoch IS NOT NULL
            ${bounded ? 'AND g.decided_epoch >= ?' : ''}
            AND ${DECIDED_STATUS_SQL}
          ORDER BY g.decided_epoch DESC, g.id ASC
          LIMIT ?`,
      )
      .bind(...(bounded ? [sinceEpoch, capped] : [capped]))
      .all<RecentDecidedAction>()
  ).results ?? [];
  return rows;
}
