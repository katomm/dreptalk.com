import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  listUnvotedEligibleActions,
  listUnrationaledVotes,
  listCohortValues,
  getNetworkTimingByType,
  listOwnVoteTimings,
} from './recordDiagnostics.js';
import { upsertVotes, getDrepParticipation } from './drepVotes.js';
import { replaceReportCards } from './drepReportCard.js';

async function seedAction(
  id: string,
  title: string,
  decidedEpoch: number | null,
  opts: { type?: string; submittedAt?: number | null; expiryEpoch?: number | null; topicId?: string | null } = {},
) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, submitted_at, expiry_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, ?, ?, 'enacted', ?, ?, ?, ?, 0, 0)`,
  )
    .bind(id, opts.type ?? 'InfoAction', title, decidedEpoch, opts.submittedAt ?? null, opts.expiryEpoch ?? null, opts.topicId ?? null)
    .run();
}

async function seedTopic(id: string, slug: string) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
     VALUES (?, 'governance', 'gov-sync', 'governance', ?, ?, 1, 0, 0, 0)`,
  )
    .bind(id, `Title ${id}`, slug)
    .run();
}

describe('listUnvotedEligibleActions', () => {
  it('lists the DReps unvoted eligible actions newest first, excluding pre-registration and vote-less actions', async () => {
    const drepId = 'drepMe';
    const registeredEpoch = 600;

    // Qualifying (decided >= registeredEpoch, at least one live DRep vote), drepMe unvoted, has a topic.
    await seedTopic('t_a', 'topic-a');
    await seedAction('ga_a', 'Action A', 600, { topicId: 't_a' });
    await upsertVotes(env.DB, 'ga_a', [{ voterRole: 'DRep', voterId: 'other1', voterHex: null, vote: 'Yes' }], 1);

    // Qualifying, drepMe unvoted, no topic.
    await seedAction('ga_b', 'Action B', 601);
    await upsertVotes(env.DB, 'ga_b', [{ voterRole: 'DRep', voterId: 'other2', voterHex: null, vote: 'No' }], 1);

    // Qualifying, but drepMe HAS a live vote here: must be excluded.
    await seedAction('ga_c', 'Action C', 602);
    await upsertVotes(
      env.DB,
      'ga_c',
      [
        { voterRole: 'DRep', voterId: 'other3', voterHex: null, vote: 'Yes' },
        { voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'Yes' },
      ],
      1,
    );

    // Has a live DRep vote (so it is "qualifying"), but decided before registration: excluded by the epoch window.
    await seedAction('ga_d', 'Action D', 599);
    await upsertVotes(env.DB, 'ga_d', [{ voterRole: 'DRep', voterId: 'other4', voterHex: null, vote: 'Yes' }], 1);

    // Decided after registration, but carries no DRep vote at all: not "votable", excluded by the EXISTS clause.
    await seedAction('ga_e', 'Action E', 603);

    const { rows, total } = await listUnvotedEligibleActions(env.DB, drepId, registeredEpoch);

    expect(rows.map((r) => r.gaId)).toEqual(['ga_b', 'ga_a']);
    expect(total).toBe(2);
    expect(rows[0].decidedEpoch).toBe(601);
    expect(rows[0].type).toBe('InfoAction');
    expect(rows[0].topicSlug).toBeNull();
    expect(rows[1].topicSlug).toBe('topic-a');
  });
});

describe('eligible - voted - unvoted identity', () => {
  it('keeps participation.eligible - participation.voted equal to unvoted.total across a mixed set', async () => {
    const drepId = 'drepMix';
    const registeredEpoch = 600;

    // Qualifying, drepMix voted.
    await seedAction('ga_v1', 'Voted A', 600);
    await upsertVotes(
      env.DB,
      'ga_v1',
      [
        { voterRole: 'DRep', voterId: 'other1', voterHex: null, vote: 'Yes' },
        { voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'Yes' },
      ],
      1,
    );

    // Qualifying, drepMix voted.
    await seedAction('ga_v2', 'Voted B', 601);
    await upsertVotes(
      env.DB,
      'ga_v2',
      [
        { voterRole: 'DRep', voterId: 'other2', voterHex: null, vote: 'No' },
        { voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'No' },
      ],
      1,
    );

    // Qualifying, drepMix did not vote.
    await seedAction('ga_u1', 'Unvoted A', 602);
    await upsertVotes(env.DB, 'ga_u1', [{ voterRole: 'DRep', voterId: 'other3', voterHex: null, vote: 'Yes' }], 1);

    // Qualifying, drepMix did not vote.
    await seedAction('ga_u2', 'Unvoted B', 603);
    await upsertVotes(env.DB, 'ga_u2', [{ voterRole: 'DRep', voterId: 'other4', voterHex: null, vote: 'Abstain' }], 1);

    // Decided before registration: excluded by the epoch window even though it has a DRep vote.
    await seedAction('ga_excluded_epoch', 'Before Registration', 599);
    await upsertVotes(env.DB, 'ga_excluded_epoch', [{ voterRole: 'DRep', voterId: 'other5', voterHex: null, vote: 'Yes' }], 1);

    // Decided after registration but carries no DRep vote at all: not votable, excluded.
    await seedAction('ga_excluded_novote', 'No DRep Vote', 604);

    const [participation, unvoted] = await Promise.all([
      getDrepParticipation(env.DB, drepId, registeredEpoch),
      listUnvotedEligibleActions(env.DB, drepId, registeredEpoch),
    ]);

    expect(participation).not.toBeNull();
    expect(participation!.eligible - participation!.voted).toBe(unvoted.total);
    expect(participation).toEqual({ eligible: 4, voted: 2 });
    expect(unvoted.total).toBe(2);
  });
});

describe('listUnrationaledVotes', () => {
  it('lists own live votes missing a rationale anchor, open action first then decided newest first', async () => {
    const drepId = 'drepMe';

    // Decided action, no anchor (NULL meta_url): included.
    await seedAction('ga_x', 'Action X', 700);
    await upsertVotes(env.DB, 'ga_x', [{ voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'Yes', metaUrl: null }], 1);

    // Open action (decided_epoch NULL), no anchor (empty string meta_url): included, sorts first.
    await seedAction('ga_open', 'Open Action', null);
    await upsertVotes(env.DB, 'ga_open', [{ voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'No', metaUrl: '' }], 1);

    // Decided action, HAS an anchor: excluded.
    await seedAction('ga_anchored', 'Anchored Action', 705);
    await upsertVotes(env.DB, 'ga_anchored', [{ voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'Yes', metaUrl: 'ipfs://r' }], 1);

    const { rows, total } = await listUnrationaledVotes(env.DB, drepId);

    expect(rows.map((r) => r.gaId)).toEqual(['ga_open', 'ga_x']);
    expect(rows[0].decidedEpoch).toBeNull();
    expect(rows[1].decidedEpoch).toBe(700);
    expect(total).toBe(2);
  });
});

describe('listCohortValues', () => {
  it('round-trips participation and rationale pct for every cohort row, including a NULL rationale', async () => {
    await replaceReportCards(env.DB, [
      {
        drepId: 'drepA',
        computedAt: 1000,
        participationPct: 80,
        participationAheadPct: 50,
        rationalePct: 40,
        rationaleAheadPct: 30,
        eligible: 10,
        cohortSize: 20,
        rationaleCohortSize: 18,
      },
      {
        drepId: 'drepB',
        computedAt: 1000,
        participationPct: 60,
        participationAheadPct: 20,
        rationalePct: null,
        rationaleAheadPct: null,
        eligible: 5,
        cohortSize: 20,
        rationaleCohortSize: 18,
      },
    ]);

    const values = await listCohortValues(env.DB);
    expect(values).toHaveLength(2);
    expect(values).toContainEqual({ participationPct: 80, rationalePct: 40 });
    expect(values).toContainEqual({ participationPct: 60, rationalePct: null });
  });
});

describe('getNetworkTimingByType', () => {
  it('computes the rn-pair median per type in days, excluding a negative-delta vote', async () => {
    // Realistic units: submitted_at in milliseconds, block_time in seconds, so a
    // unit mix-up in the SQL (missing the *1000.0 normalization) would fail this.
    const submittedAt = 1_780_000_000_000; // ms
    const baseSec = 1_780_000_000; // submittedAt / 1000, seconds
    const daySec = 86_400;

    async function seedTimedVote(gaId: string, type: string, dayOffset: number, voterId: string, decidedEpoch: number | null) {
      await seedAction(gaId, `Action ${gaId}`, decidedEpoch, { type, submittedAt });
      await upsertVotes(
        env.DB,
        gaId,
        [{ voterRole: 'DRep', voterId, voterHex: null, vote: 'Yes', blockTime: baseSec + dayOffset * daySec }],
        1,
      );
    }

    // TreasuryWithdrawals: day offsets 1, 2, 10 -> odd n=3, rn-pair collapses to the single middle row (day 2).
    await seedTimedVote('ga_tw1', 'TreasuryWithdrawals', 1, 'voterTw1', 900);
    await seedTimedVote('ga_tw2', 'TreasuryWithdrawals', 2, 'voterTw2', 901);
    await seedTimedVote('ga_tw3', 'TreasuryWithdrawals', 10, 'voterTw3', 902);
    // Negative delta (block_time before submitted_at): excluded, must not shift the median or the count.
    await seedTimedVote('ga_tw_neg', 'TreasuryWithdrawals', -1, 'voterTwNeg', 903);

    // ParameterChange: day offsets 2, 4 -> even n=2, rn-pair averages both middle rows ((2+4)/2 = 3).
    await seedTimedVote('ga_pc1', 'ParameterChange', 2, 'voterPc1', 900);
    await seedTimedVote('ga_pc2', 'ParameterChange', 4, 'voterPc2', 901);

    const results = await getNetworkTimingByType(env.DB);
    const byType = new Map(results.map((r) => [r.type, r]));

    expect(byType.get('TreasuryWithdrawals')?.timedVotes).toBe(3);
    expect(byType.get('TreasuryWithdrawals')?.medianDay).toBeCloseTo(2);
    expect(byType.get('ParameterChange')?.timedVotes).toBe(2);
    expect(byType.get('ParameterChange')?.medianDay).toBeCloseTo(3);
  });
});

describe('listOwnVoteTimings', () => {
  it('returns only the DReps own live timed votes, with type, timestamps, and the action epochs', async () => {
    const drepId = 'drepMe';
    const submittedAt = 1_780_000_000_000; // ms
    const blockTime = 1_780_086_400; // one day later, seconds

    await seedAction('ga_own1', 'Own Timed Action', 950, { submittedAt, type: 'TreasuryWithdrawals', expiryEpoch: 955 });
    await upsertVotes(
      env.DB,
      'ga_own1',
      [
        { voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'Yes', blockTime },
        // A different DRep's timed vote on the same action must not appear in drepMe's own timings.
        { voterRole: 'DRep', voterId: 'someoneElse', voterHex: null, vote: 'No', blockTime: blockTime + 1000 },
      ],
      1,
    );

    // Own vote with no block_time: excluded (untimed).
    await seedAction('ga_own2', 'Untimed Own Action', 951, { submittedAt, type: 'InfoAction' });
    await upsertVotes(env.DB, 'ga_own2', [{ voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'Abstain' }], 1);

    const rows = await listOwnVoteTimings(env.DB, drepId);
    expect(rows).toEqual([{ type: 'TreasuryWithdrawals', blockTime, submittedAt, decidedEpoch: 950, expiryEpoch: 955 }]);
  });
});
