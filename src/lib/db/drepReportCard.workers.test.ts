import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  listQualifyingDecidedEpochs,
  listDrepVoteCounts,
  listDrepRationaleCounts,
  listCohortCandidates,
  replaceReportCards,
  getReportCard,
  type ReportCardRow,
} from './drepReportCard.js';
import { upsertVotes } from './drepVotes.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';
import { computeReportCards } from '../analytics/reportCardView.js';

async function seedAction(id: string, decidedEpoch: number | null) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', ?, NULL, 0, 0)`,
  ).bind(id, id, decidedEpoch).run();
}

async function seedDrep(drepId: string, extra: Partial<{ active: number; registeredEpoch: number | null }> = {}) {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, status, active, registered_epoch, last_synced_at, created_at)
     VALUES (?, 'registered', ?, ?, 0, 0)`,
  ).bind(drepId, extra.active ?? 1, extra.registeredEpoch ?? null).run();
}

function reportCardRow(i: number): ReportCardRow {
  return {
    drepId: `drep_chunk_${i}`,
    computedAt: 1000 + i,
    participationPct: i,
    participationAheadPct: i,
    rationalePct: i % 2 === 0 ? null : i / 100,
    rationaleAheadPct: i % 2 === 0 ? null : i,
    eligible: i,
    cohortSize: 25,
    rationaleCohortSize: 25,
  };
}

describe('listQualifyingDecidedEpochs', () => {
  it('excludes an action without any DRep vote and one with only SPO votes, ascends, one entry per action', async () => {
    await seedAction('ga_novote', 500);
    await seedAction('ga_spo_only', 505);
    await upsertVotes(env.DB, 'ga_spo_only', [{ voterRole: 'SPO', voterId: 'pool1', voterHex: null, vote: 'Yes' }], 1);
    await seedAction('ga_qual_a', 520);
    await upsertVotes(env.DB, 'ga_qual_a', [{ voterRole: 'DRep', voterId: 'drepA', voterHex: null, vote: 'Yes' }], 1);
    // Same decided epoch as ga_qual_a, must still produce its own entry.
    await seedAction('ga_qual_b', 520);
    await upsertVotes(env.DB, 'ga_qual_b', [{ voterRole: 'DRep', voterId: 'drepB', voterHex: null, vote: 'No' }], 1);
    await seedAction('ga_qual_c', 510);
    await upsertVotes(env.DB, 'ga_qual_c', [{ voterRole: 'DRep', voterId: 'drepC', voterHex: null, vote: 'Abstain' }], 1);

    const epochs = await listQualifyingDecidedEpochs(env.DB);
    expect(epochs).toEqual([510, 520, 520]);
  });
});

describe('listDrepVoteCounts', () => {
  it('counts only live DRep votes on qualifying actions decided at/after the voters own registered epoch', async () => {
    await seedDrep('drepEarly', { registeredEpoch: 520 });
    await seedDrep('drepLate', { registeredEpoch: 500 });
    await seedDrep('drepUnregistered', { registeredEpoch: null });

    // Decided epoch 510: before drepEarly registered, at/after drepLate registered.
    await seedAction('ga1', 510);
    await upsertVotes(env.DB, 'ga1', [
      { voterRole: 'DRep', voterId: 'drepEarly', voterHex: null, vote: 'Yes' },
      { voterRole: 'DRep', voterId: 'drepLate', voterHex: null, vote: 'Yes' },
      { voterRole: 'DRep', voterId: 'drepUnregistered', voterHex: null, vote: 'Yes' },
    ], 1);

    // Decided epoch 525: at/after drepEarly registered too.
    await seedAction('ga2', 525);
    await upsertVotes(env.DB, 'ga2', [
      { voterRole: 'DRep', voterId: 'drepEarly', voterHex: null, vote: 'No' },
    ], 1);

    const counts = await listDrepVoteCounts(env.DB);
    expect(counts.get('drepEarly')).toBe(1); // only ga2 (ga1 predates registration)
    expect(counts.get('drepLate')).toBe(1); // only ga1
    expect(counts.has('drepUnregistered')).toBe(false); // no registered_epoch, join excludes it
    expect(counts.has(SPECIAL_DREP_IDS[0])).toBe(false); // specials cast no votes, never appear
  });
});

describe('listDrepRationaleCounts', () => {
  it('counts empty-string and NULL meta_url both as without a rationale', async () => {
    await seedAction('gaR1', 500);
    await upsertVotes(env.DB, 'gaR1', [
      { voterRole: 'DRep', voterId: 'drepR', voterHex: null, vote: 'Yes', metaUrl: null },
    ], 1);
    await seedAction('gaR2', 505);
    await upsertVotes(env.DB, 'gaR2', [
      { voterRole: 'DRep', voterId: 'drepR', voterHex: null, vote: 'Yes', metaUrl: '' },
    ], 1);
    await seedAction('gaR3', 510);
    await upsertVotes(env.DB, 'gaR3', [
      { voterRole: 'DRep', voterId: 'drepR', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://r' },
    ], 1);

    const counts = await listDrepRationaleCounts(env.DB);
    expect(counts.get('drepR')).toEqual({ total: 3, withRationale: 1 });
  });
});

describe('listCohortCandidates', () => {
  it('excludes inactive, NULL registered_epoch, and the special pseudo-DReps', async () => {
    await seedDrep('drepActive', { active: 1, registeredEpoch: 500 });
    await seedDrep('drepInactive', { active: 0, registeredEpoch: 500 });
    await seedDrep('drepNoEpoch', { active: 1, registeredEpoch: null });
    await seedDrep(SPECIAL_DREP_IDS[0], { active: 1, registeredEpoch: 500 });

    const candidates = await listCohortCandidates(env.DB);
    expect(candidates).toEqual([{ drepId: 'drepActive', registeredEpoch: 500 }]);
  });
});

describe('replaceReportCards + getReportCard', () => {
  it('writes rows, reads one back field-exact, and atomically swaps on replace', async () => {
    const rowA: ReportCardRow = {
      drepId: 'drepA',
      computedAt: 1000,
      participationPct: 0.75,
      participationAheadPct: 40,
      rationalePct: 0.5,
      rationaleAheadPct: 20,
      eligible: 12,
      cohortSize: 200,
      rationaleCohortSize: 180,
    };
    const rowB: ReportCardRow = {
      drepId: 'drepB',
      computedAt: 1000,
      participationPct: 0.9,
      participationAheadPct: 10,
      rationalePct: null,
      rationaleAheadPct: null,
      eligible: 5,
      cohortSize: 200,
      rationaleCohortSize: 180,
    };

    await replaceReportCards(env.DB, [rowA, rowB]);
    expect(await getReportCard(env.DB, 'drepA')).toEqual(rowA);
    expect(await getReportCard(env.DB, 'drepB')).toEqual(rowB); // nullable rationale fields round-trip as NULL

    await replaceReportCards(env.DB, [rowB]);
    expect(await getReportCard(env.DB, 'drepA')).toBeNull(); // atomic swap: gone
    expect(await getReportCard(env.DB, 'drepB')).toEqual(rowB);
  });

  it('replaces 25 rows across the 10-row chunk boundary and all round-trip', async () => {
    // 25 rows spans three INSERT chunks (10, 10, 5), pinning the chunk math by
    // row count. Miniflare does not enforce D1's real 100-bind-per-statement
    // cap, so a bug that widened REPLACE_CHUNK past the cap would not fail
    // here on the bind count alone, only this row-count check catches it.
    const rows = Array.from({ length: 25 }, (_, i) => reportCardRow(i + 1));
    await replaceReportCards(env.DB, rows);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_report_card').first<{ n: number }>();
    expect(count?.n).toBe(25);

    expect(await getReportCard(env.DB, 'drep_chunk_25')).toEqual(rows[24]);
  });

  it('clears the table when replacing with an empty list', async () => {
    await replaceReportCards(env.DB, [reportCardRow(1)]);
    expect(await getReportCard(env.DB, 'drep_chunk_1')).not.toBeNull();

    await replaceReportCards(env.DB, []);
    expect(await getReportCard(env.DB, 'drep_chunk_1')).toBeNull();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_report_card').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('end to end: reads to compute to write', () => {
  it('ranks a three-member cohort by participation and excludes an active special DRep', async () => {
    // Three cohort members, same registered_epoch, distinct participation:
    // drepFull votes on all 5 qualifying actions (100%), drepMid on 3 (60%),
    // drepLow on 1 (20%). The special DRep is seeded active with full
    // participation too, to prove listCohortCandidates keeps it out of the
    // cohort even though nothing about its votes would exclude it.
    await seedDrep('drepFull', { registeredEpoch: 500 });
    await seedDrep('drepMid', { registeredEpoch: 500 });
    await seedDrep('drepLow', { registeredEpoch: 500 });
    await seedDrep(SPECIAL_DREP_IDS[0], { active: 1, registeredEpoch: 500 });

    for (let i = 1; i <= 5; i += 1) {
      await seedAction(`ga_rc${i}`, 500 + i);
    }
    // drepFull: all 5. drepMid: the first 3. drepLow: the first 1.
    // The special DRep votes on all 5 too, same as drepFull.
    for (let i = 1; i <= 5; i += 1) {
      const votes = [
        { voterRole: 'DRep', voterId: 'drepFull', voterHex: null, vote: 'Yes' },
        { voterRole: 'DRep', voterId: SPECIAL_DREP_IDS[0], voterHex: null, vote: 'Yes' },
      ];
      if (i <= 3) votes.push({ voterRole: 'DRep', voterId: 'drepMid', voterHex: null, vote: 'Yes' });
      if (i <= 1) votes.push({ voterRole: 'DRep', voterId: 'drepLow', voterHex: null, vote: 'No' });
      await upsertVotes(env.DB, `ga_rc${i}`, votes, 1);
    }

    const [candidates, qualifyingEpochs, voteCounts, rationaleCounts] = await Promise.all([
      listCohortCandidates(env.DB),
      listQualifyingDecidedEpochs(env.DB),
      listDrepVoteCounts(env.DB),
      listDrepRationaleCounts(env.DB),
    ]);
    // The special DRep never becomes a candidate, regardless of its votes.
    expect(candidates.map((c) => c.drepId).sort()).toEqual(['drepFull', 'drepLow', 'drepMid']);

    const rows = computeReportCards({ candidates, qualifyingEpochs, voteCounts, rationaleCounts, now: 12345 });
    await replaceReportCards(env.DB, rows);

    // drepMid sits strictly between drepLow (20%) and drepFull (100%) in a
    // cohort of 3, so exactly 1 of 3 members ranks below it: floor(100/3) = 33.
    const mid = await getReportCard(env.DB, 'drepMid');
    expect(mid).not.toBeNull();
    expect(mid?.eligible).toBe(5);
    expect(mid?.cohortSize).toBe(3);
    expect(mid?.participationPct).toBeCloseTo(60);
    expect(mid?.participationAheadPct).toBe(33);

    // The special DRep's full participation would otherwise have ranked it
    // first, but it was never a candidate, so it has no report-card row at all.
    expect(await getReportCard(env.DB, SPECIAL_DREP_IDS[0])).toBeNull();
  });
});
