/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for survey_tally and survey_tally_queue. All queries
// use .prepare().bind(), never string-concatenated SQL. The surveys sync phase
// is the only writer, and every row here is derived from a bundle and a power
// snapshot, so a row is replaced or deleted, never patched in place.
import type { ArtifactQuestion } from 'cip-179/tally';
import type { ExclusionKey } from 'cip-179/domain';
import { chunked, D1_MAX_BINDS, sqlPlaceholders } from './sql.js';

/** Which source produced the weighted half of a tally. */
export type WeightedSource = 'live' | 'artifact';

/**
 * Which source produced the head count half. 'audit' is our own unit-weight run
 * over the bundle. 'artifact' is the sealed case only: auditResponses counts a
 * sealed response for participation but cannot see its answers, so its
 * per-question head counts are the artifact's post-membership set, and the card
 * must say so rather than implying a wider head count exists.
 */
export type HeadcountSource = 'audit' | 'artifact';

/** Both tally runs, in the one shape cip-179 commits. */
export interface StoredQuestions {
  /** Every counted DRep at weight 1n. The head count of record. */
  headcount: ArtifactQuestion[];
  /** Matched DReps at their voting power, or the artifact's own questions. */
  weighted: ArtifactQuestion[];
}

export interface NewSurveyTally {
  surveyRef: string;
  weightedSource: WeightedSource;
  /** 'audit' everywhere except a sealed survey, whose answers we cannot see. */
  headcountSource: HeadcountSource;
  artifactHash: string | null;
  powerEpoch: number;
  questions: StoredQuestions;
  counted: number;
  matchedCount: number;
  /** Lovelace, decimal string. May be "0". */
  answeredPower: string;
  /** Lovelace, decimal string, or null when unknown. Never "0" for unknown. */
  totalPower: string | null;
  excluded: number;
  /** Null means unknown. An empty object would claim nothing was excluded. */
  excludedBy: Partial<Record<ExclusionKey, number>> | null;
  /**
   * Counted responses per claimed role. NULL means DRep only, never unknown: the
   * line it feeds exists to name the OTHER roles that answered, so a DRep-only
   * survey has nothing to store. That is a different NULL from excludedBy's in
   * the same row, where NULL does mean unknown.
   */
  roleCounts: Record<number, number> | null;
  /** Unix SECONDS, the snapshot stamp of the bundle behind the head count. */
  bundleFetchedAt: number;
  /**
   * Unix SECONDS, the same unit as bundleFetchedAt. The run clock of the sync
   * phase is unix ms, so a writer reduces it before it reaches this field, and
   * the card multiplies by 1000 to read the reading's own age back.
   */
  computedAt: number;
  /**
   * The survey's artifact_hash as it stood when the computation started. The
   * write lands only if the survey row still exists, is not unavailable, and
   * still carries exactly this value, so a fetch that finished after a rollback
   * or after a new artifact appeared cannot overwrite a newer state.
   */
  expectedArtifactHash: string | null;
}

export interface SurveyTallyRow extends Omit<NewSurveyTally, 'expectedArtifactHash'> {}

interface RawSurveyTallyRow {
  survey_ref: string;
  weighted_source: string;
  headcount_source: string;
  artifact_hash: string | null;
  power_epoch: number;
  questions: string;
  counted: number;
  matched_count: number;
  answered_power: string;
  total_power: string | null;
  excluded: number;
  excluded_by: string | null;
  role_counts: string | null;
  bundle_fetched_at: number;
  computed_at: number;
}

function rowToTally(r: RawSurveyTallyRow): SurveyTallyRow {
  return {
    surveyRef: r.survey_ref,
    weightedSource: r.weighted_source as WeightedSource,
    headcountSource: r.headcount_source as HeadcountSource,
    artifactHash: r.artifact_hash,
    powerEpoch: r.power_epoch,
    questions: JSON.parse(r.questions) as StoredQuestions,
    counted: r.counted,
    matchedCount: r.matched_count,
    answeredPower: r.answered_power,
    totalPower: r.total_power,
    excluded: r.excluded,
    excludedBy: r.excluded_by === null ? null : (JSON.parse(r.excluded_by) as Partial<Record<ExclusionKey, number>>),
    roleCounts: r.role_counts === null ? null : (JSON.parse(r.role_counts) as Record<number, number>),
    bundleFetchedAt: r.bundle_fetched_at,
    computedAt: r.computed_at,
  };
}

/**
 * Write one tally, replacing whatever was there. Returns false when the write
 * was refused, which is a stale result to drop rather than an error to report.
 *
 * The guard and the write are ONE statement on purpose. A SELECT followed by an
 * INSERT leaves a window in which the survey is withdrawn or its artifact moves,
 * and the INSERT would then store the stale result anyway. INSERT ... SELECT
 * with the condition in its WHERE closes that window, and meta.changes says
 * whether the row was accepted.
 */
export async function upsertSurveyTally(db: D1Database, t: NewSurveyTally): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO survey_tally
         (survey_ref, weighted_source, headcount_source, artifact_hash, power_epoch, questions, counted,
          matched_count, answered_power, total_power, excluded, excluded_by, role_counts,
          bundle_fetched_at, computed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM survey
       WHERE survey.ref = ?
         AND survey.unavailable = 0
         AND survey.artifact_hash IS ?
       ON CONFLICT(survey_ref) DO UPDATE SET
         weighted_source = excluded.weighted_source,
         headcount_source = excluded.headcount_source,
         artifact_hash = excluded.artifact_hash,
         power_epoch = excluded.power_epoch,
         questions = excluded.questions,
         counted = excluded.counted,
         matched_count = excluded.matched_count,
         answered_power = excluded.answered_power,
         total_power = excluded.total_power,
         excluded = excluded.excluded,
         excluded_by = excluded.excluded_by,
         role_counts = excluded.role_counts,
         bundle_fetched_at = excluded.bundle_fetched_at,
         computed_at = excluded.computed_at`,
    )
    .bind(
      t.surveyRef,
      t.weightedSource,
      t.headcountSource,
      t.artifactHash,
      t.powerEpoch,
      JSON.stringify(t.questions),
      t.counted,
      t.matchedCount,
      t.answeredPower,
      t.totalPower,
      t.excluded,
      t.excludedBy === null ? null : JSON.stringify(t.excludedBy),
      t.roleCounts === null ? null : JSON.stringify(t.roleCounts),
      t.bundleFetchedAt,
      t.computedAt,
      // The guard's own binds, in WHERE order.
      t.surveyRef,
      t.expectedArtifactHash,
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getSurveyTally(db: D1Database, ref: string): Promise<SurveyTallyRow | null> {
  const row = await db
    .prepare('SELECT * FROM survey_tally WHERE survey_ref = ?')
    .bind(ref)
    .first<RawSurveyTallyRow>();
  return row ? rowToTally(row) : null;
}

/**
 * Live rows whose weighting stands on an older epoch than the newest one the
 * power history holds. Artifact rows are deliberately excluded: their
 * power_epoch is the survey's end_epoch, so the newest local epoch passes it
 * permanently and they would requeue for ever.
 */
export async function getStaleLiveRefs(
  db: D1Database,
  epoch: number,
  limit: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT survey_ref FROM survey_tally
       WHERE weighted_source = 'live' AND power_epoch < ?
       ORDER BY power_epoch, survey_ref
       LIMIT ?`,
    )
    .bind(epoch, limit)
    .all<{ survey_ref: string }>();
  return (results ?? []).map(r => r.survey_ref);
}

/** Queue a survey for the tally pass. Idempotent, and it never resets an
 * existing row's attempt counter, so a repeatedly failing survey keeps its
 * place at the back of the work order. */
export async function enqueueSurveyTallies(
  db: D1Database,
  refs: readonly string[],
  now: number,
): Promise<void> {
  if (refs.length === 0) return;
  // Two binds per row, so chunk at half the statement's bind budget.
  for (const chunk of chunked(refs, Math.floor(D1_MAX_BINDS / 2))) {
    await db.batch(
      chunk.map(ref =>
        db
          .prepare(
            `INSERT INTO survey_tally_queue (survey_ref, queued_at)
             VALUES (?, ?) ON CONFLICT(survey_ref) DO NOTHING`,
          )
          .bind(ref, now),
      ),
    );
  }
}

/** The next `limit` queued surveys, least recently attempted first. NULLs sort
 * first in SQLite, so one never tried comes before one tried and failed.
 *
 * Only the refs. The conditional dequeue matches on the attempt stamp its caller
 * wrote through markSurveyTallyAttempt, which the caller already holds, so
 * returning the stored stamp here would be a field nothing reads. */
export async function takeSurveyTallyWork(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT survey_ref FROM survey_tally_queue
       ORDER BY last_attempt, queued_at
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ survey_ref: string }>();
  return (results ?? []).map(r => r.survey_ref);
}

/** Refs of eligible surveys that have no tally row at all, bounded. The
 * backfill trigger: on the day the migration lands both new tables are empty
 * while the mirror's delta cursor is not, so a stored survey that gets no
 * further delta is in no queue, and getStaleLiveRefs cannot see it either
 * because that query reads the very table it has no row in. Eligibility is
 * checked again by the pass, this only narrows the scan. */
export async function getRefsWithoutTally(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT s.ref AS ref FROM survey s
       LEFT JOIN survey_tally t ON t.survey_ref = s.ref
       WHERE t.survey_ref IS NULL
         AND s.unavailable = 0
         AND s.cancelled = 0
         AND s.external_content = 0
         AND (s.final_state IS NULL OR s.final_state <> 'untalliable')
       ORDER BY s.ref
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ ref: string }>();
  return (results ?? []).map(r => r.ref);
}

export async function markSurveyTallyAttempt(
  db: D1Database,
  ref: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE survey_tally_queue SET attempts = attempts + 1, last_attempt = ?
       WHERE survey_ref = ?`,
    )
    .bind(now, ref)
    .run();
}

/**
 * Drop a queue row, but only the exact one this pass attempted. A survey
 * re-enqueued by a later delta while the bundle was in flight must keep its new
 * queue row, so the delete matches on the attempt stamp the pass itself wrote.
 */
export async function dequeueSurveyTally(
  db: D1Database,
  ref: string,
  expectedLastAttempt: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM survey_tally_queue WHERE survey_ref = ? AND last_attempt = ?')
    .bind(ref, expectedLastAttempt)
    .run();
}

/** Drop derived rows for surveys that are gone. D1 has no cascade, and
 * withdrawSurveys only deletes unpublished surveys, so the caller decides
 * which refs reach this. */
export async function deleteSurveyTallies(db: D1Database, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return;
  for (const chunk of chunked(refs, D1_MAX_BINDS)) {
    const list = sqlPlaceholders(chunk);
    await db.batch([
      db.prepare(`DELETE FROM survey_tally WHERE survey_ref IN (${list})`).bind(...chunk),
      db.prepare(`DELETE FROM survey_tally_queue WHERE survey_ref IN (${list})`).bind(...chunk),
    ]);
  }
}
