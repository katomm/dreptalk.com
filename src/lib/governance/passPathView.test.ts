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
import { ccRowView, hardBlockLines, PASS_LIST_FOOTNOTE, PASS_PATH_FOOTNOTE, passPathRow, stakeRowView } from './passPathView.js';
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

const produced: string[] = [];
function keep<T>(v: T): T {
  produced.push(JSON.stringify(v));
  return v;
}

describe('stakeRowView tier lines', () => {
  it('nonVoters, DRep and SPO', () => {
    const b = buckets({ Y: 40n * ADA, N: 10n * ADA, Dv: 50n * ADA });
    expect(keep(row('DRep', b, 67)).line).toBe(
      "Reachable if DReps who haven't voted yet vote Yes. 27 ₳ more yes needed.",
    );
    expect(keep(row('SPO', b, 67)).line).toBe(
      "Reachable if pools who haven't voted yet vote Yes. 27 ₳ more yes needed.",
    );
  });

  it('abstainers, DRep, share a third at 67', () => {
    const b = buckets({ Y: 60n * ADA, N: 40n * ADA, A: 100n * ADA });
    expect(keep(row('DRep', b, 67)).line).toBe(
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
    expect(keep(row('SPO', spoBuckets(view), 51)).line).toBe(
      "Needs 11 ₳ more yes. Pools that haven't voted can't carry it alone, pools that voted Abstain or default to always abstain would have to vote Yes too (they count at 49%).",
    );
  });

  it('noVoters, DRep and SPO', () => {
    const b = buckets({ Y: 10n, N: 60n, Dv: 30n });
    expect(keep(row('DRep', b, 67)).line).toBe('Only reachable if DReps who voted No switch to Yes.');
    expect(keep(row('SPO', b, 67)).line).toBe('Only reachable if pools who voted No switch to Yes.');
  });

  it('fixed, the three variants', () => {
    expect(keep(row('DRep', buckets({ F: 40n, Dv: 60n }), 67)).line).toBe(
      "Can't be reached by votes. Always-no-confidence stake alone blocks it.",
    );
    const inactive =
      "Not reachable with today's active DReps. It would take inactive DReps whose stake still counts as No voting again.";
    expect(keep(row('DRep', buckets({ Dx: 40n, Dv: 60n }), 67)).line).toBe(inactive);
    expect(keep(row('DRep', buckets({ Dv: 64n, Dx: 26n, F: 10n }), 67)).line).toBe(inactive);
    expect(keep(row('DRep', buckets({ Dx: 5n, F: 40n, Dv: 55n }), 67)).line).toBe(
      "Can't be reached by votes. Always-no-confidence stake alone blocks it.",
    );
  });
});

describe('SPO abstainers copy on a hard fork', () => {
  it('names only the pools that voted Abstain, the passive ones already count as not voted', () => {
    const b = buckets({ Y: 40n * ADA, N: 60n * ADA, A: 60n * ADA });
    const tier = reachTier(b, 51)!;
    expect(
      keep(stakeRowView({ body: 'SPO', tier, buckets: b, list: null, comparison: null, actionHref: HREF, passiveAbstainInA: false }))
        .line,
    ).toBe(
      "Needs 11 ₳ more yes. Pools that haven't voted can't carry it alone, pools that voted Abstain would have to vote Yes too (they count at 49%).",
    );
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
    const v = keep(stakeRowView({ body: 'DRep', tier: t, buckets: b, list, comparison: null, actionHref: HREF }));
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
    const a = keep(stakeRowView({ body: 'DRep', tier: t, buckets: b, list: withAbstain, comparison: null, actionHref: HREF }));
    expect(a.list).toBeNull();
    const ab = fewestToPass([cands[0], cand('drep1dd', 30n * ADA, 'Abstain')], t, ['Abstain'], 0n);
    const v2 = keep(stakeRowView({ body: 'DRep', tier: t, buckets: b, list: ab, comparison: null, actionHref: HREF }));
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
    const v = keep(stakeRowView({ body: 'DRep', tier: tt, buckets: bb, list, comparison, actionHref: HREF }));
    expect(v.list?.rows).toHaveLength(2);
    expect(v.list?.comparison).toBe('If DReps who voted No switch as well: at least 1 DRep.');
    expect(v.list?.summary).toBe('2 DReps would have to switch, 1 if No voters switch too');
    expect(v.list?.intro).toBe(
      'The fewest DReps whose switch to Yes would reach the 67.0% threshold, ordered by how much each switch counts. 7 ₳ more yes is needed.',
    );
    expect(v.list?.abstainNote).toBe(
      'A DRep who voted Abstain counts at a third of their voting power, because a switch also adds their stake to the counted total.',
    );
    const same = fewestToPass(pool, tt, ['notVoted', 'Abstain', 'No'], 0n);
    const one = fewestToPass([pool[2]], tt, ['notVoted', 'Abstain', 'No'], 0n);
    const solo = keep(stakeRowView({ body: 'DRep', tier: tt, buckets: bb, list: one, comparison: same, actionHref: HREF }));
    expect(solo.list?.comparison).toBeNull();
    expect(solo.list?.summary).toBe('1 DRep would have to switch');
    expect(solo.list?.abstainNote).toBeNull();
  });
});

describe('ccRowView', () => {
  it('words each tier', () => {
    expect(keep(ccRowView(ccSeatsToPass({ yes: 0, no: 0, abstain: 0, size: 7 }, 66.67)!)).line).toBe(
      "Reachable if 5 of the 7 members who haven't voted vote Yes.",
    );
    expect(keep(ccRowView(ccSeatsToPass({ yes: 3, no: 2, abstain: 2, size: 7 }, 66.67)!)).line).toBe(
      'Needs 1 more Yes, including members who abstained.',
    );
    expect(keep(ccRowView(ccSeatsToPass({ yes: 2, no: 5, abstain: 0, size: 7 }, 66.67)!)).line).toBe(
      'Only reachable if members who voted No switch to Yes.',
    );
  });
});

describe('hardBlockLines', () => {
  it('NCL headroom exceeded', () => {
    expect(
      keep(hardBlockLines({ withdrawal: 25_000_000n * ADA, nclRemaining: 3_500_000n * ADA, ccBlocked: false, ccVotes: true })),
    ).toEqual(["Exceeds the Net Change Limit headroom (3.5M ₳ left). Can't be enacted in this period, whatever the votes."]);
  });

  it('committee below minimum, only where the CC votes', () => {
    expect(keep(hardBlockLines({ withdrawal: null, nclRemaining: null, ccBlocked: true, ccVotes: true }))).toEqual([
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
    activeYesPower: 10,
    activeNoPower: 20,
    activeAbstainPower: 0,
    noSidePower: '90',
    alwaysAbstainPower: '0',
    alwaysNoConfidencePower: '0',
    approvalThresholdPct: 67,
  }) as BodyStakeView;
  const voters = [cand('drep1n', 20n, 'No'), cand('drep1v', 70n, 'notVoted', 'Vee'), cand('drep1y', 10n, 'Yes')];
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
    expect(passPathRow(cc, ctx)?.line).toBe("Reachable if 5 of the 7 members who haven't voted vote Yes.");
    expect(passPathRow(cc, { ...ctx, ccBlocked: true })).toBeNull();
    expect(passPathRow(cc, { ...ctx, ccBoundarySize: null })).toBeNull();
  });

  it('notVoted rows link to the profile slug when there is one', () => {
    const v = passPathRow(drepRow, { ...ctx, passCandidates: [voters[0], { ...voters[1], slug: 'vee' }, voters[2]] })!;
    expect(v.list?.rows[0].href).toBe('/dreps/vee/');
  });
});

describe('copy rules', () => {
  it('no dashes, semicolons or lands anywhere', () => {
    const all = [...produced, PASS_PATH_FOOTNOTE, PASS_LIST_FOOTNOTE];
    expect(produced.length).toBeGreaterThan(10);
    for (const s of all) expect(s).not.toMatch(/[—–―;]|&mdash;|&ndash;|\blands?\b/);
  });
});
