/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for drep_report_card: precomputed report-card
// percentiles per DRep, refreshed by the 6-hourly drep-report-card sync
// phase. replaceReportCards swaps the whole table atomically (a DELETE-all
// plus the fresh chunked INSERTs in ONE db.batch), so a reader never sees a
// mix of stale and fresh rows mid-refresh. The stored pct values are frozen
// at compute time, for ranking transparency, while the profile page keeps
// showing its own live participation/rationale numbers and only attaches
// the percentile read from this table. A live metric and a slightly stale
// percentile can therefore coexist without contradicting each other.

import { SPECIAL_DREP_IDS } from '../dreps/special.js';
import { sqlPlaceholders } from './sql.js';
import { concludedStatusSql } from './sql.js';
import { liveVoteSql } from './drepVotes.js';

export interface ReportCardRow {
  drepId: string;
  computedAt: number;
  participationPct: number;
  participationAheadPct: number;
  rationalePct: number | null;
  rationaleAheadPct: number | null;
  eligible: number;
  cohortSize: number;
  rationaleCohortSize: number;
}

// Raw row shape as stored in D1 (snake_case columns).
interface ReportCardDbRow {
  drep_id: string;
  computed_at: number;
  participation_pct: number;
  participation_ahead_pct: number;
  rationale_pct: number | null;
  rationale_ahead_pct: number | null;
  eligible: number;
  cohort_size: number;
  rationale_cohort_size: number;
}

function rowToReportCard(row: ReportCardDbRow): ReportCardRow {
  return {
    drepId: row.drep_id,
    computedAt: row.computed_at,
    participationPct: row.participation_pct,
    participationAheadPct: row.participation_ahead_pct,
    rationalePct: row.rationale_pct,
    rationaleAheadPct: row.rationale_ahead_pct,
    eligible: row.eligible,
    cohortSize: row.cohort_size,
    rationaleCohortSize: row.rationale_cohort_size,
  };
}

// D1 caps bound params at 100 per statement. Each row binds 9 values
// (drep_id, computed_at, participation_pct, participation_ahead_pct,
// rationale_pct, rationale_ahead_pct, eligible, cohort_size,
// rationale_cohort_size), so 10 rows per INSERT keeps binds at 90.
const REPLACE_CHUNK = 10;

/**
 * Atomically replaces the whole table with the given rows: a DELETE-all
 * followed by chunked multi-row INSERTs, all in ONE db.batch call, so a
 * concurrent reader (the profile) never observes a partially refreshed
 * table. Called once per 6-hourly sync run with the full computed cohort.
 * An empty rows list still clears the table (no cohort member qualified).
 */
export async function replaceReportCards(db: D1Database, rows: ReportCardRow[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM drep_report_card')];
  for (let i = 0; i < rows.length; i += REPLACE_CHUNK) {
    const chunk = rows.slice(i, i + REPLACE_CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const binds = chunk.flatMap((r) => [
      r.drepId,
      r.computedAt,
      r.participationPct,
      r.participationAheadPct,
      r.rationalePct,
      r.rationaleAheadPct,
      r.eligible,
      r.cohortSize,
      r.rationaleCohortSize,
    ]);
    stmts.push(
      db
        .prepare(
          `INSERT INTO drep_report_card
             (drep_id, computed_at, participation_pct, participation_ahead_pct,
              rationale_pct, rationale_ahead_pct, eligible, cohort_size, rationale_cohort_size)
           VALUES ${values}`,
        )
        .bind(...binds),
    );
  }
  await db.batch(stmts);
}

/** The stored report-card row for one DRep, or null when it is not a cohort member. */
export async function getReportCard(db: D1Database, drepId: string): Promise<ReportCardRow | null> {
  const row = await db
    .prepare('SELECT * FROM drep_report_card WHERE drep_id = ?')
    .bind(drepId)
    .first<ReportCardDbRow>();
  return row ? rowToReportCard(row) : null;
}

/**
 * Decided epochs of qualifying actions (decided_epoch not null, at least one
 * live DRep vote), one entry PER ACTION and ascending, so two actions decided
 * in the same epoch produce two entries. Mirrors getDrepParticipation's
 * qualifying-action rule (a decided action only counts once a DRep actually
 * could and did vote on it).
 */
export async function listQualifyingDecidedEpochs(db: D1Database): Promise<number[]> {
  const rows = (
    await db
      .prepare(
        `SELECT g.decided_epoch AS decided_epoch
           FROM governance_actions g
          WHERE g.decided_epoch IS NOT NULL AND ${concludedStatusSql('g')}
            AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep' AND ${liveVoteSql('dv')})
          ORDER BY g.decided_epoch ASC`,
      )
      .all<{ decided_epoch: number }>()
  ).results ?? [];
  return rows.map((r) => r.decided_epoch);
}

/**
 * Live DRep vote counts on qualifying actions (see listQualifyingDecidedEpochs)
 * decided at or after the voter's own registered_epoch, grouped by voter.
 * Mirrors getDrepParticipation's numerator verbatim, batched across every DRep
 * in one query instead of one round-trip per DRep. The join to dreps means an
 * unregistered voter (no row, or a NULL registered_epoch) never appears in the
 * map, and the pseudo-DReps cast no votes, so they never appear either.
 */
export async function listDrepVoteCounts(db: D1Database): Promise<Map<string, number>> {
  const rows = (
    await db
      .prepare(
        `SELECT v.voter_id, COUNT(*) AS voted
           FROM drep_votes v
           JOIN dreps d ON d.drep_id = v.voter_id
           JOIN governance_actions g ON g.id = v.ga_id AND g.decided_epoch IS NOT NULL
                AND ${concludedStatusSql('g')}
                AND g.decided_epoch >= d.registered_epoch
          WHERE v.voter_role = 'DRep' AND ${liveVoteSql('v')}
            AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep' AND ${liveVoteSql('dv')})
          GROUP BY v.voter_id`,
      )
      .all<{ voter_id: string; voted: number }>()
  ).results ?? [];
  return new Map(rows.map((r) => [r.voter_id, r.voted]));
}

/**
 * Rationale-attachment counts over ALL live DRep votes, grouped by voter.
 * Same predicate family as getDrepRationaleStats (a vote counts "without" when
 * meta_url is NULL or empty), batched across every DRep in one query.
 */
export async function listDrepRationaleCounts(
  db: D1Database,
): Promise<Map<string, { total: number; withRationale: number }>> {
  const rows = (
    await db
      .prepare(
        `SELECT voter_id,
                COUNT(*) AS total,
                SUM(CASE WHEN meta_url IS NULL OR meta_url = '' THEN 0 ELSE 1 END) AS with_rationale
           FROM drep_votes
          WHERE voter_role = 'DRep' AND ${liveVoteSql()}
          GROUP BY voter_id`,
      )
      .all<{ voter_id: string; total: number; with_rationale: number }>()
  ).results ?? [];
  return new Map(rows.map((r) => [r.voter_id, { total: r.total, withRationale: r.with_rationale }]));
}

/**
 * Cohort candidates for the report-card compute: active DReps with a known
 * registered_epoch, excluding the pseudo-DReps (SPECIAL_DREP_IDS), which cast
 * no votes and are standing options, not representative actors.
 */
export async function listCohortCandidates(
  db: D1Database,
): Promise<{ drepId: string; registeredEpoch: number }[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, registered_epoch
           FROM dreps
          WHERE active = 1 AND registered_epoch IS NOT NULL
            AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ drep_id: string; registered_epoch: number }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, registeredEpoch: r.registered_epoch }));
}
