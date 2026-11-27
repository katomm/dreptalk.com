import { describe, expect, it } from 'vitest';
import { buildBodyStake } from './fullStakeView.js';
import {
  ccSeatsToPass,
  fewestToPass,
  reachTier,
  spoBuckets,
  type FewestResult,
  type PassCandidate,
  type StakeBuckets,
  type StakeTier,
} from './passPath.js';
import { ccRowView, hardBlockLines, passPathRow, stakeRowView } from './passPathView.js';
import type { BodyStakeView } from './fullStakeView.js';

const ADA = 1_000_000n;
const HREF = '/t/some-action-abc12345/';

function buckets(b: Partial<StakeBuckets>): StakeBuckets {
  return { Y: 0n, N: 0n, Dv: 0n, Dx: 0n, F: 0n, A: 0n, ...b };
}

function row(body: 'DRep' | 'SPO', b: StakeBuckets, pct: number, list: FewestResult | null = null, comparison: FewestResult | null = null) {
  const tier = reachTier(b, pct) as StakeTier;
  return stakeRowView({ body, tier, buckets: b, list, comparison, actionHref: HREF });
}

const cand = (drepId: string, power: bigint, stance: PassCandidate['stance'], name: string | null = null): PassCandidate => ({
  drepId,
  name,
  power,
  stance,
});

describe('stakeRowView tier lines', () => {
  it('nonVoters, DRep and SPO', () => {
    const b = buckets({ Y: 40n * ADA, N: 10n * ADA, Dv: 50n * ADA });
    expect(row('DRep', b, 67).line).toBe(
      "Reachable if DReps who haven't voted yet vote Yes. 27 ₳ more yes needed.",
    );
    expect(row('SPO', b, 67).line).toBe(
      "Reachable if pools who haven't voted yet vote Yes. 27 ₳ more yes needed.",
    );
  });

  it('abstainers, DRep, share a third at 67', () => {
    const b = buckets({ Y: 60n * ADA, N: 40n * ADA, A: 100n * ADA });
    expect(row('DRep', b, 67).line).toBe(
      "Needs 7 ₳ more yes. DReps who haven't voted can't carry it alone, abstainers would have to switch too.",
    );
  });

  it('abstainers, SPO, share 49% at 51, for passive always-abstain pools', () => {
    const view = buildBodyStake({
      actionType: 'ParameterChange',
      body: 'SPO',
      activeYesPower: 40_000_000,
      activeNoPower: 60_000_000,
      activeAbstainPower: 0,
      noSidePower: '60000000',
      alwaysAbstainPower: '60000000',
      alwaysNoConfidencePower: '0',
      approvalThresholdPct: 51,
    })!;
    expect(row('SPO', spoBuckets(view), 51).line).toBe(
      "Needs 11 ₳ more yes. Pools that haven't voted can't carry it alone, pools that voted Abstain or default to always abstain would have to vote Yes too (they count at 49%).",
    );
  });

  it('noVoters, DRep and SPO', () => {
    const b = buckets({ Y: 10n, N: 60n, Dv: 30n });
    expect(row('DRep', b, 67).line).toBe('Only reachable if DReps who voted No switch to Yes.');
    expect(row('SPO', b, 67).line).toBe('Only reachable if pools who voted No switch to Yes.');
  });

  it('fixed: names inactive DReps when they decide, else the always-no-confidence stake', () => {
    expect(row('DRep', buckets({ F: 40n, Dv: 60n }), 67).line).toMatch(/no-confidence/);
    expect(row('DRep', buckets({ Dx: 40n, Dv: 60n }), 67).line).toMatch(/inactive DReps/);
    expect(row('DRep', buckets({ Dv: 64n, Dx: 26n, F: 10n }), 67).line).toMatch(/inactive DReps/);
    expect(row('DRep', buckets({ Dx: 5n, F: 40n, Dv: 55n }), 67).line).toMatch(/no-confidence/);
  });
});

describe('SPO abstainers copy on a hard fork', () => {
  it('names only the pools that voted Abstain, the passive ones already count as not voted', () => {
    const b = buckets({ Y: 40n * ADA, N: 60n * ADA, A: 60n * ADA });
    const tier = reachTier(b, 51)!;
    const { line } = stakeRowView({ body: 'SPO', tier, buckets: b, list: null, comparison: null, actionHref: HREF, passiveAbstainInA: false });
    expect(line).toContain('11 ₳ more yes');
    expect(line).toContain('(they count at 49%)');
    expect(line).not.toMatch(/always abstain/);
  });
});

describe('stakeRowView list', () => {
  const b = buckets({ Y: 40n * ADA, N: 60n * ADA, Dv: 30n * ADA, A: 50n * ADA });
  const t = reachTier(b, 50)!;
  const cands = [
    cand('drep1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 28n * ADA, 'Abstain', 'Abby'),
    cand('drep1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 20n * ADA, 'notVoted'),
    cand('drep1cccccccccccccccccccccccccccccc', 15n * ADA, 'No', 'Nora'),
  ];

  it('rows, hrefs per stance, closes only for Abstain', () => {
    const list = fewestToPass(cands, t, ['notVoted', 'Abstain', 'No'], b.Dv);
    const v = stakeRowView({ body: 'DRep', tier: t, buckets: b, list, comparison: null, actionHref: HREF });
    expect(v.list?.rows).toEqual([
      {
        name: 'drep1bbbb...bbbbbbbb',
        stanceLabel: 'Not voted',
        powerLabel: '20 ₳',
        closes: null,
        href: '/dreps/drep1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/',
      },
      {
        name: 'Nora',
        stanceLabel: 'No',
        powerLabel: '15 ₳',
        closes: null,
        href: `${HREF}?tab=positions&voter=drep1cccccccccccccccccccccccccccccc#voter-drep1cccccccccccccccccccccccccccccc`,
      },
    ]);
    const withAbstain = fewestToPass(cands, t, ['Abstain'], b.Dv);
    const a = stakeRowView({ body: 'DRep', tier: t, buckets: b, list: withAbstain, comparison: null, actionHref: HREF });
    expect(a.list).toBeNull();
    const ab = fewestToPass([cands[0], cand('drep1dd', 30n * ADA, 'Abstain')], t, ['Abstain'], 0n);
    const v2 = stakeRowView({ body: 'DRep', tier: t, buckets: b, list: ab, comparison: null, actionHref: HREF });
    expect(v2.list?.rows[0]).toMatchObject({
      stanceLabel: 'Abstain',
      closes: {
        label: 'closes 15 ₳',
        tip: 'A switch from Abstain adds 30 ₳ to Yes and to the counted total, so it closes the gap by 15 ₳.',
      },
    });
  });

  it('hidden when the list does not reach', () => {
    const list = fewestToPass([cand('drep1x', 1n, 'notVoted')], t, ['notVoted'], b.Dv);
    expect(list.reaches).toBe(false);
    expect(stakeRowView({ body: 'DRep', tier: t, buckets: b, list, comparison: null, actionHref: HREF }).list).toBeNull();
  });

  it('no list for SPOs', () => {
    const list = fewestToPass(cands, t, ['notVoted', 'Abstain', 'No'], b.Dv);
    expect(stakeRowView({ body: 'SPO', tier: t, buckets: b, list, comparison: null, actionHref: HREF }).list).toBeNull();
  });

  it('comparison line on the abstainers tier', () => {
    const bb = buckets({ Y: 60n * ADA, N: 40n * ADA, A: 100n * ADA });
    const tt = reachTier(bb, 67)!;
    const pool = [cand('drep1a', 15n * ADA, 'Abstain'), cand('drep1b', 15n * ADA, 'Abstain'), cand('drep1n', 40n * ADA, 'No')];
    const list = fewestToPass(pool, tt, ['notVoted', 'Abstain'], 0n);
    const comparison = fewestToPass(pool, tt, ['notVoted', 'Abstain', 'No'], 0n);
    const v = stakeRowView({ body: 'DRep', tier: tt, buckets: bb, list, comparison, actionHref: HREF });
    expect(v.list?.rows).toHaveLength(2);
    expect(v.list?.comparison).toBe('If DReps who voted No switch as well: at least 1 DRep.');
    expect(v.list?.summary).toBe('2 DReps would have to switch, 1 if No voters switch too');
    expect(v.list?.intro).toContain('67.0%');
    expect(v.list?.intro).toContain('7 ₳ more yes');
    expect(v.list?.abstainNote).toContain('a third');
    const same = fewestToPass(pool, tt, ['notVoted', 'Abstain', 'No'], 0n);
    const one = fewestToPass([pool[2]], tt, ['notVoted', 'Abstain', 'No'], 0n);
    const solo = stakeRowView({ body: 'DRep', tier: tt, buckets: bb, list: one, comparison: same, actionHref: HREF });
    expect(solo.list?.comparison).toBeNull();
    expect(solo.list?.summary).toBe('1 DRep would have to switch');
    expect(solo.list?.abstainNote).toBeNull();
  });
});

describe('ccRowView', () => {
  it('gives the seat counts per tier', () => {
    expect(ccRowView(ccSeatsToPass({ yes: 0, no: 0, abstain: 0, size: 7 }, 66.67)!).line).toContain('5 of the 7 members');
    const abstained = ccRowView(ccSeatsToPass({ yes: 3, no: 2, abstain: 2, size: 7 }, 66.67)!).line;
    expect(abstained).toContain('1 more Yes');
    expect(abstained).toMatch(/abstained/);
    expect(ccRowView(ccSeatsToPass({ yes: 2, no: 5, abstain: 0, size: 7 }, 66.67)!).line).toMatch(/voted No switch/);
  });
});

describe('hardBlockLines', () => {
  it('NCL headroom exceeded', () => {
    expect(
      hardBlockLines({ withdrawal: 25_000_000n * ADA, nclRemaining: 3_500_000n * ADA, ccBlocked: false, ccVotes: true }),
    ).toEqual(["Exceeds the Net Change Limit headroom (3.5M ₳ left). Can't be enacted in this period, whatever the votes."]);
  });

  it('committee below minimum, only where the CC votes', () => {
    expect(hardBlockLines({ withdrawal: null, nclRemaining: null, ccBlocked: true, ccVotes: true })).toEqual([
      'The committee is below its minimum size, so no action that needs it can pass.',
    ]);
    expect(hardBlockLines({ withdrawal: null, nclRemaining: null, ccBlocked: true, ccVotes: false })).toEqual([]);
  });

  it('nothing when within headroom', () => {
    expect(hardBlockLines({ withdrawal: 1n, nclRemaining: 1n, ccBlocked: false, ccVotes: true })).toEqual([]);
  });
});

describe('passPathRow', () => {
  const stake = buildBodyStake({
    actionType: 'TreasuryWithdrawals',
    body: 'DRep',
    activeYesPower: 40,
    activeNoPower: 20,
    activeAbstainPower: 0,
    noSidePower: '60',
    alwaysAbstainPower: '0',
    alwaysNoConfidencePower: '0',
    approvalThresholdPct: 67,
  }) as BodyStakeView;
  const voters = [cand('drep1n', 20n, 'No'), cand('drep1v', 40n, 'notVoted', 'Vee'), cand('drep1y', 40n, 'Yes')];
  const ctx = {
    isActive: true,
    ccBlocked: false,
    ccBoundarySize: 7,
    cc: { yes: 0, no: 0, abstain: 0 },
    passCandidates: voters,
    actionHref: HREF,
  };
  const drepRow = { body: 'DRep' as const, met: false as boolean | null, thresholdPct: 67 as number | null, stake: stake as BodyStakeView | null };

  it('DRep row with a reconciled population gets a tier line and list', () => {
    const v = passPathRow(drepRow, ctx)!;
    expect(v.line).toMatch(/^Reachable if DReps who haven't voted yet vote Yes\./);
    expect(v.list?.rows.map((r) => r.name)).toEqual(['Vee']);
    expect(v.list?.summary).toBe('1 DRep voting Yes would reach 67.0%');
    // The fixture is in lovelace, so the gap rounds to 0 ₳ here.
    expect(v.list?.intro).toMatch(
      /^The fewest DReps who haven't voted yet whose Yes votes would reach the 67\.0% threshold, largest first\. That takes .+ more yes\.$/,
    );
  });

  it('early phase: nothing while more power has not voted than has voted', () => {
    const early = buildBodyStake({
      actionType: 'TreasuryWithdrawals',
      body: 'DRep',
      activeYesPower: 10,
      activeNoPower: 20,
      activeAbstainPower: 0,
      noSidePower: '90',
      alwaysAbstainPower: '0',
      alwaysNoConfidencePower: '0',
      approvalThresholdPct: 67,
    }) as BodyStakeView;
    const earlyVoters = [cand('drep1n', 20n, 'No'), cand('drep1v', 70n, 'notVoted'), cand('drep1y', 10n, 'Yes')];
    expect(passPathRow({ ...drepRow, stake: early }, { ...ctx, passCandidates: earlyVoters })).toBeNull();
    const spo = buildBodyStake({
      actionType: 'ParameterChange',
      body: 'SPO',
      activeYesPower: 10,
      activeNoPower: 20,
      activeAbstainPower: 0,
      noSidePower: '90',
      alwaysAbstainPower: '0',
      alwaysNoConfidencePower: '0',
      approvalThresholdPct: 51,
    }) as BodyStakeView;
    expect(passPathRow({ body: 'SPO', met: false, thresholdPct: 51, stake: spo }, ctx)).toBeNull();
  });

  it('nothing on a closed action, a met row or a row without a threshold', () => {
    expect(passPathRow(drepRow, { ...ctx, isActive: false })).toBeNull();
    expect(passPathRow({ ...drepRow, met: true }, ctx)).toBeNull();
    expect(passPathRow({ ...drepRow, met: null }, ctx)).toBeNull();
    expect(passPathRow({ ...drepRow, thresholdPct: null }, ctx)).toBeNull();
  });

  it('DRep row stays quiet without candidates or when they do not reconcile', () => {
    expect(passPathRow(drepRow, { ...ctx, passCandidates: null })).toBeNull();
    expect(passPathRow(drepRow, { ...ctx, passCandidates: [cand('drep1n', 25n, 'No'), voters[2]] })).toBeNull();
    expect(passPathRow(drepRow, { ...ctx, passCandidates: voters.slice(0, 2) })).toBeNull();
  });

  it('CC row: seats from the boundary committee, nothing when blocked or unknown', () => {
    const cc = { body: 'CC' as const, met: false, thresholdPct: 66.67, stake: null };
    const half = { ...ctx, cc: { yes: 2, no: 2, abstain: 0 } };
    expect(passPathRow(cc, half)?.line).toBe("Reachable if 3 of the 3 members who haven't voted vote Yes.");
    expect(passPathRow(cc, { ...half, ccBlocked: true })).toBeNull();
    expect(passPathRow(cc, { ...half, ccBoundarySize: null })).toBeNull();
  });

  it('CC row: nothing in the early phase, while more seats have not voted than have', () => {
    const cc = { body: 'CC' as const, met: false, thresholdPct: 66.67, stake: null };
    expect(passPathRow(cc, ctx)).toBeNull();
    expect(passPathRow(cc, { ...ctx, cc: { yes: 1, no: 2, abstain: 0 } })).toBeNull();
    expect(passPathRow(cc, { ...ctx, ccBlocked: true })).toBeNull();
    expect(passPathRow(cc, { ...ctx, ccBoundarySize: null })).toBeNull();
  });

  it('notVoted rows link to the profile slug when there is one', () => {
    const v = passPathRow(drepRow, { ...ctx, passCandidates: [voters[0], { ...voters[1], slug: 'vee' }, voters[2]] })!;
    expect(v.list?.rows[0].href).toBe('/dreps/vee/');
  });
});
