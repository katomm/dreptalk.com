import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  dequeueSurveyTally,
  deleteSurveyTallies,
  enqueueSurveyTallies,
  getRefsWithoutTally,
  getStaleLiveRefs,
  getSurveyTally,
  markSurveyTallyAttempt,
  takeSurveyTallyWork,
  upsertSurveyTally,
  type NewSurveyTally,
} from './surveyTally.js';

const db = env.DB as D1Database;
const REF = `${'a'.repeat(64)}:0`;
const REF2 = `${'b'.repeat(64)}:0`;

/** The write is guarded against the survey table, so a test that expects it to
 * land must have the survey row. eligible_roles is JSON, as migration 0094
 * stores it. */
async function seedSurvey(ref: string, artifactHash: string | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO survey
         (ref, end_epoch, eligible_roles, sealed, cancelled, external_content,
          definition, submitted_at, synced_at, artifact_hash)
       VALUES (?, 316, '[0]', 0, 0, 0, '{}', 0, 0, ?)`,
    )
    .bind(ref, artifactHash)
    .run();
}

function tally(overrides: Partial<NewSurveyTally> = {}): NewSurveyTally {
  return {
    surveyRef: REF,
    weightedSource: 'live',
    headcountSource: 'audit',
    artifactHash: null,
    expectedArtifactHash: null,
    powerEpoch: 310,
    questions: { headcount: [], weighted: [] },
    counted: 2,
    matchedCount: 1,
    answeredPower: '5000000000000',
    totalPower: '20000000000000',
    excluded: 3,
    excludedBy: { superseded: 3 },
    roleCounts: { 0: 2 },
    bundleFetchedAt: 1_700_000_000,
    computedAt: 1_700_000_100,
    ...overrides,
  };
}

describe('survey_tally storage', () => {
  it('round-trips every field, decoding the JSON columns', async () => {
    await seedSurvey(REF);
    await upsertSurveyTally(db, tally());
    const row = await getSurveyTally(db, REF);
    expect(row).not.toBeNull();
    expect(row!.weightedSource).toBe('live');
    expect(row!.artifactHash).toBeNull();
    expect(row!.answeredPower).toBe('5000000000000');
    expect(row!.excludedBy).toEqual({ superseded: 3 });
    expect(row!.roleCounts).toEqual({ 0: 2 });
    expect(row!.questions.headcount).toEqual([]);
  });

  it('keeps an unknown exclusion breakdown as null, never as an empty object', async () => {
    await seedSurvey(REF);
    await upsertSurveyTally(db, tally({ excludedBy: null }));
    const row = await getSurveyTally(db, REF);
    expect(row!.excludedBy).toBeNull();
  });

  it('keeps an unknown total power as null rather than zero', async () => {
    await seedSurvey(REF);
    await upsertSurveyTally(db, tally({ totalPower: null }));
    const row = await getSurveyTally(db, REF);
    expect(row!.totalPower).toBeNull();
  });

  it('refuses the write when the survey row is gone', async () => {
    // No seedSurvey: the guarded write must not land for a survey that a
    // rollback deleted while the bundle was being collected.
    const wrote = await upsertSurveyTally(db, tally());
    expect(wrote).toBe(false);
    expect(await getSurveyTally(db, REF)).toBeNull();
  });

  it('refuses the write when the survey was flagged unavailable during the fetch', async () => {
    await seedSurvey(REF);
    // The survey table's own CHECK only allows unavailable = 1 alongside a
    // topic_id, a published row is the only one ever flagged this way, a row
    // with no thread is deleted outright. So the case has to carry one too.
    await db
      .prepare('UPDATE survey SET unavailable = 1, topic_id = ? WHERE ref = ?')
      .bind('t1', REF)
      .run();
    expect(await upsertSurveyTally(db, tally())).toBe(false);
    expect(await getSurveyTally(db, REF)).toBeNull();
  });

  it('refuses the write when the artifact moved while the bundle was collected', async () => {
    // Computed against no artifact, but a new one appeared before the write.
    await seedSurvey(REF, 'cd'.repeat(32));
    expect(await upsertSurveyTally(db, tally({ expectedArtifactHash: null }))).toBe(false);
    // And it lands once the expectation matches what the survey now carries.
    expect(
      await upsertSurveyTally(
        db,
        tally({ expectedArtifactHash: 'cd'.repeat(32), artifactHash: 'cd'.repeat(32), weightedSource: 'artifact' }),
      ),
    ).toBe(true);
  });

  it('lists stale live rows and ignores artifact rows at the same epoch', async () => {
    await seedSurvey(REF);
    await seedSurvey(REF2, 'ab'.repeat(32));
    await upsertSurveyTally(db, tally({ surveyRef: REF, powerEpoch: 309 }));
    await upsertSurveyTally(
      db,
      tally({
        surveyRef: REF2,
        weightedSource: 'artifact',
        artifactHash: 'ab'.repeat(32),
        expectedArtifactHash: 'ab'.repeat(32),
        powerEpoch: 300,
      }),
    );
    expect(await getStaleLiveRefs(db, 310, 10)).toEqual([REF]);
  });

  it('finds eligible surveys that have no tally row at all', async () => {
    await seedSurvey(REF);
    await seedSurvey(REF2);
    await upsertSurveyTally(db, tally({ surveyRef: REF }));
    expect(await getRefsWithoutTally(db, 10)).toEqual([REF2]);
  });

  it('excludes cancelled, external-content and untalliable surveys from the backfill scan', async () => {
    await seedSurvey(REF);
    await db.prepare('UPDATE survey SET cancelled = 1 WHERE ref = ?').bind(REF).run();
    expect(await getRefsWithoutTally(db, 10)).toEqual([]);
  });

  it('hands out queue work least recently attempted first', async () => {
    await enqueueSurveyTallies(db, [REF, REF2], 1_700_000_000);
    await markSurveyTallyAttempt(db, REF, 1_700_000_500);
    expect(await takeSurveyTallyWork(db, 10)).toEqual([REF2, REF]);
  });

  it('keeps a queue row until it is dequeued with the attempt it was given', async () => {
    await enqueueSurveyTallies(db, [REF], 1_700_000_000);
    await markSurveyTallyAttempt(db, REF, 1_700_000_500);
    expect(await takeSurveyTallyWork(db, 10)).toEqual([REF]);
    await dequeueSurveyTally(db, REF, 1_700_000_500);
    expect(await takeSurveyTallyWork(db, 10)).toEqual([]);
  });

  it('keeps a queue row that was re-attempted after this pass stamped it', async () => {
    // A later run stamped a new attempt, so the earlier run's dequeue must miss.
    await enqueueSurveyTallies(db, [REF], 1_700_000_000);
    await markSurveyTallyAttempt(db, REF, 1_700_000_500);
    await markSurveyTallyAttempt(db, REF, 1_700_000_900);
    await dequeueSurveyTally(db, REF, 1_700_000_500);
    expect(await takeSurveyTallyWork(db, 10)).toEqual([REF]);
  });

  it('enqueues idempotently without resetting the attempt counter', async () => {
    await enqueueSurveyTallies(db, [REF], 1_700_000_000);
    await markSurveyTallyAttempt(db, REF, 1_700_000_500);
    await enqueueSurveyTallies(db, [REF], 1_700_001_000);
    const row = await db
      .prepare('SELECT attempts FROM survey_tally_queue WHERE survey_ref = ?')
      .bind(REF)
      .first<{ attempts: number }>();
    expect(row!.attempts).toBe(1);
  });

  it('deletes tally rows and their queue rows together', async () => {
    await seedSurvey(REF);
    await upsertSurveyTally(db, tally());
    await enqueueSurveyTallies(db, [REF], 1_700_000_000);
    await deleteSurveyTallies(db, [REF]);
    expect(await getSurveyTally(db, REF)).toBeNull();
    expect(await takeSurveyTallyWork(db, 10)).toEqual([]);
  });
});
