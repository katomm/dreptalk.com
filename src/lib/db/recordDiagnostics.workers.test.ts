import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  listUnvotedEligibleActions,
  listUnrationaledVotes,
  listCohortValues,
  getNetworkTimingByType,
  getNetworkTimingOverall,
  getHalfTurnoutDays,
  getWindowThirds,
  listOwnVoteTimings,
} from './recordDiagnostics.js';
import { upsertVotes, getDrepParticipation } from './drepVotes.js';
import { replaceReportCards } from './drepReportCard.js';

async function seedAction(
  id: string,
  title: string,
  decidedEpoch: number | null,
  opts: { type?: string; submittedAt?: number | null; expiryEpoch?: number | null; topicId?: string | null; status?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, submitted_at, expiry_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  )
    .bind(
      id,
      opts.type ?? 'InfoAction',
      title,
      opts.status ?? 'enacted',
      decidedEpoch,
      opts.submittedAt ?? null,
      opts.expiryEpoch ?? null,
      opts.topicId ?? null,
    )
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
  it('computes the rn-pair median per type in days, excluding a negative-delta vote and an open action', async () => {
    // Realistic units: submitted_at in milliseconds, block_time in seconds, so a
    // unit mix-up in the SQL (missing the *1000.0 normalization) would fail this.
    const submittedAt = 1_780_000_000_000; // ms
    const baseSec = 1_780_000_000; // submittedAt / 1000, seconds
    const daySec = 86_400;

    async function seedTimedVote(
      gaId: string,
      type: string,
      dayOffset: number,
      voterId: string,
      decidedEpoch: number | null,
      status?: string,
    ) {
      await seedAction(gaId, `Action ${gaId}`, decidedEpoch, { type, submittedAt, status });
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
    // Still-open action (status 'active'), timed and positive-delta: excluded, it can only hold an
    // early vote so far and would otherwise drag the median down to day 0.
    await seedTimedVote('ga_tw_open', 'TreasuryWithdrawals', 0, 'voterTwOpen', 904, 'active');

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

describe('getNetworkTimingByType role filter', () => {
  it('defaults to DRep votes and filters to SPO votes when role is SPO', async () => {
    // Realistic units: submitted_at in milliseconds, block_time in seconds.
    const submittedAt = 1_780_000_000_000; // ms
    const baseSec = 1_780_000_000; // seconds
    const daySec = 86_400;

    await seedAction('ga_role_drep', 'DRep Action', 900, { type: 'InfoAction', submittedAt });
    await upsertVotes(
      env.DB,
      'ga_role_drep',
      [{ voterRole: 'DRep', voterId: 'voterD', voterHex: null, vote: 'Yes', blockTime: baseSec + 1 * daySec }],
      1,
    );

    await seedAction('ga_role_spo', 'SPO Action', 901, { type: 'InfoAction', submittedAt });
    await upsertVotes(
      env.DB,
      'ga_role_spo',
      [{ voterRole: 'SPO', voterId: 'voterS', voterHex: null, vote: 'Yes', blockTime: baseSec + 5 * daySec }],
      1,
    );

    const drepResults = await getNetworkTimingByType(env.DB);
    const drepByType = new Map(drepResults.map((r) => [r.type, r]));
    expect(drepByType.get('InfoAction')?.timedVotes).toBe(1);
    expect(drepByType.get('InfoAction')?.medianDay).toBeCloseTo(1);

    const spoResults = await getNetworkTimingByType(env.DB, 'SPO');
    const spoByType = new Map(spoResults.map((r) => [r.type, r]));
    expect(spoByType.get('InfoAction')?.timedVotes).toBe(1);
    expect(spoByType.get('InfoAction')?.medianDay).toBeCloseTo(5);
  });
});

describe('getNetworkTimingOverall', () => {
  it('computes the overall median across types, excluding an open action, and returns null when no timed votes exist for the role', async () => {
    const submittedAt = 1_780_000_000_000; // ms
    const baseSec = 1_780_000_000; // seconds
    const daySec = 86_400;

    async function seedTimedDrepVote(
      gaId: string,
      type: string,
      dayOffset: number,
      voterId: string,
      decidedEpoch: number | null,
      status?: string,
    ) {
      await seedAction(gaId, `Action ${gaId}`, decidedEpoch, { type, submittedAt, status });
      await upsertVotes(
        env.DB,
        gaId,
        [{ voterRole: 'DRep', voterId, voterHex: null, vote: 'Yes', blockTime: baseSec + dayOffset * daySec }],
        1,
      );
    }

    // Odd n=3 spread across different types: overall median ignores the type partition.
    await seedTimedDrepVote('ga_ov1', 'InfoAction', 1, 'voterOv1', 900);
    await seedTimedDrepVote('ga_ov2', 'TreasuryWithdrawals', 2, 'voterOv2', 901);
    await seedTimedDrepVote('ga_ov3', 'ParameterChange', 10, 'voterOv3', 902);
    // Still-open action (status 'active'), timed and positive-delta: excluded, it can only hold an
    // early vote so far and would otherwise pull the overall median toward day 0.
    await seedTimedDrepVote('ga_ov_open', 'InfoAction', 0, 'voterOvOpen', 903, 'active');

    const overall = await getNetworkTimingOverall(env.DB, 'DRep');
    expect(overall?.timedVotes).toBe(3);
    expect(overall?.medianDay).toBeCloseTo(2);

    const noSpo = await getNetworkTimingOverall(env.DB, 'SPO');
    expect(noSpo).toBeNull();
  });
});

describe('getHalfTurnoutDays', () => {
  it('returns the day of the ceil(n/2)-th vote per decided action with at least 2 timed DRep votes', async () => {
    const submittedAt = 1_780_000_000_000; // ms
    const baseSec = 1_780_000_000; // seconds
    const daySec = 86_400;

    // 3 votes at days 1, 3, 5 -> n=3, rn=(3+1)/2=2 -> day 3.
    await seedAction('ga_ht3', 'Half Turnout 3', 900, { submittedAt });
    await upsertVotes(
      env.DB,
      'ga_ht3',
      [
        { voterRole: 'DRep', voterId: 'v1', voterHex: null, vote: 'Yes', blockTime: baseSec + 1 * daySec },
        { voterRole: 'DRep', voterId: 'v2', voterHex: null, vote: 'Yes', blockTime: baseSec + 3 * daySec },
        { voterRole: 'DRep', voterId: 'v3', voterHex: null, vote: 'Yes', blockTime: baseSec + 5 * daySec },
      ],
      1,
    );

    // 4 votes at days 1, 2, 3, 4 -> n=4, rn=(4+1)/2=2 (integer division) -> day 2.
    await seedAction('ga_ht4', 'Half Turnout 4', 901, { submittedAt });
    await upsertVotes(
      env.DB,
      'ga_ht4',
      [
        { voterRole: 'DRep', voterId: 'v4', voterHex: null, vote: 'Yes', blockTime: baseSec + 1 * daySec },
        { voterRole: 'DRep', voterId: 'v5', voterHex: null, vote: 'Yes', blockTime: baseSec + 2 * daySec },
        { voterRole: 'DRep', voterId: 'v6', voterHex: null, vote: 'Yes', blockTime: baseSec + 3 * daySec },
        { voterRole: 'DRep', voterId: 'v7', voterHex: null, vote: 'Yes', blockTime: baseSec + 4 * daySec },
      ],
      1,
    );

    // A single timed vote: excluded, n < 2.
    await seedAction('ga_ht_single', 'Single Vote', 902, { submittedAt });
    await upsertVotes(
      env.DB,
      'ga_ht_single',
      [{ voterRole: 'DRep', voterId: 'v8', voterHex: null, vote: 'Yes', blockTime: baseSec + 1 * daySec }],
      1,
    );

    // Open action (not decided) with 2 timed votes: excluded.
    await seedAction('ga_ht_open', 'Open Action', null, { submittedAt });
    await upsertVotes(
      env.DB,
      'ga_ht_open',
      [
        { voterRole: 'DRep', voterId: 'v9', voterHex: null, vote: 'Yes', blockTime: baseSec + 1 * daySec },
        { voterRole: 'DRep', voterId: 'v10', voterHex: null, vote: 'Yes', blockTime: baseSec + 2 * daySec },
      ],
      1,
    );

    const days = await getHalfTurnoutDays(env.DB);
    const sorted = days.slice().sort((a, b) => a - b);
    expect(sorted.length).toBe(2);
    expect(sorted[0]).toBeCloseTo(2);
    expect(sorted[1]).toBeCloseTo(3);
  });
});

describe('getWindowThirds', () => {
  it('classifies votes into early/middle/late/afterClose against a hand-built window', async () => {
    // Fake anchor: epoch 0 at unix 0, so realistic ms/s values expose a unit mix-up.
    const anchor = { epoch: 0, unixSeconds: 0 };
    const daySec = 86_400;

    // Submitted at the anchor. Expiry one epoch (5 days) after the anchor, decided_epoch
    // is set far later so MIN(decided, expiry) picks the expiry epoch as the window end.
    await seedAction('ga_win', 'Window Action', 100, { submittedAt: 0, expiryEpoch: 1 });
    await upsertVotes(
      env.DB,
      'ga_win',
      [
        // position 1/5 (< 1/3): early.
        { voterRole: 'DRep', voterId: 'w1', voterHex: null, vote: 'Yes', blockTime: 1 * daySec },
        // position 1/2 (between 1/3 and 2/3): middle.
        { voterRole: 'DRep', voterId: 'w2', voterHex: null, vote: 'Yes', blockTime: 2.5 * daySec },
        // position 9/10 (> 2/3, <= 1): late.
        { voterRole: 'DRep', voterId: 'w3', voterHex: null, vote: 'Yes', blockTime: 4.5 * daySec },
        // position 6/5 (> 1): afterClose, not part of the basis.
        { voterRole: 'DRep', voterId: 'w4', voterHex: null, vote: 'Yes', blockTime: 6 * daySec },
      ],
      1,
    );

    const thirds = await getWindowThirds(env.DB, anchor);
    expect(thirds).toEqual({ early: 1, middle: 1, late: 1, afterClose: 1, basis: 3 });
  });

  it('ends an enacted action one epoch before its decided epoch, the enactment epoch', async () => {
    // Same hand-built anchor: epoch 0 at unix 0, one epoch is 5 days.
    const anchor = { epoch: 0, unixSeconds: 0 };
    const daySec = 86_400;

    // Enacted, so decided_epoch 2 is the ENACTMENT epoch and voting stopped at the
    // start of the ratification epoch 1 (day 5). The vote on day 6 sits inside
    // epoch 1, past the window end, so it is afterClose and not a late vote. No
    // expiry epoch, so the end comes from decided_epoch alone.
    await seedAction('ga_enacted_win', 'Enacted Window Action', 2, { submittedAt: 0, status: 'enacted' });
    await upsertVotes(
      env.DB,
      'ga_enacted_win',
      [{ voterRole: 'DRep', voterId: 'e1', voterHex: null, vote: 'Yes', blockTime: 6 * daySec }],
      1,
    );

    const thirds = await getWindowThirds(env.DB, anchor);
    expect(thirds).toEqual({ early: 0, middle: 0, late: 0, afterClose: 1, basis: 0 });
  });
});

describe('dropped actions excluded from decided-timing reads', () => {
  it('contributes nothing to half-turnout days or window thirds despite carrying decided_epoch', async () => {
    // tallySync also sets decided_epoch from dropped_epoch, so decided_epoch IS NOT NULL
    // alone is not a safe "voting concluded normally" proxy. Two timed votes so this
    // action would qualify for both reads if the status filter were missing.
    const anchor = { epoch: 0, unixSeconds: 0 };
    const daySec = 86_400;

    await seedAction('ga_dropped', 'Dropped Action', 100, { submittedAt: 0, expiryEpoch: 1, status: 'dropped' });
    await upsertVotes(
      env.DB,
      'ga_dropped',
      [
        { voterRole: 'DRep', voterId: 'd1', voterHex: null, vote: 'Yes', blockTime: 1 * daySec },
        { voterRole: 'DRep', voterId: 'd2', voterHex: null, vote: 'Yes', blockTime: 2.5 * daySec },
      ],
      1,
    );

    const days = await getHalfTurnoutDays(env.DB);
    expect(days).toEqual([]);

    const thirds = await getWindowThirds(env.DB, anchor);
    expect(thirds).toEqual({ early: 0, middle: 0, late: 0, afterClose: 0, basis: 0 });
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
    expect(rows).toEqual([
      { type: 'TreasuryWithdrawals', blockTime, submittedAt, decidedEpoch: 950, expiryEpoch: 955, status: 'enacted' },
    ]);
  });
});
