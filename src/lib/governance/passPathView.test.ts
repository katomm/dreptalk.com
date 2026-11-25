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
import { ccRowView, hardBlockLines, PASS_LIST_FOOTNOTE, PASS_PATH_FOOTNOTE, stakeRowView } from './passPathView.js';

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
      "DReps who haven't voted can't carry it alone. Abstainers would have to switch to Yes too. Still missing: 7 ₳ of yes, or the equivalent from abstainers, who count at a third.",
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
      "Pools that haven't voted can't carry it alone. Pools that voted Abstain or default to always abstain would have to vote Yes too. Still missing: 11 ₳ of yes, or the equivalent from them, who count at 49%.",
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
    expect(keep(row('DRep', buckets({ Dx: 40n, Dv: 60n }), 67)).line).toBe(
      "Can't be reached by votes. Stake of inactive DReps still counted as No blocks it.",
    );
    expect(keep(row('DRep', buckets({ Dv: 64n, Dx: 26n, F: 10n }), 67)).line).toBe(
      "Can't be reached by votes. Always-no-confidence stake and stake of inactive DReps still counted as No block it together.",
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

  it('rows, hrefs per stance, counts only for Abstain', () => {
    const list = fewestToPass(cands, t, ['notVoted', 'Abstain', 'No'], b.Dv);
    const v = keep(stakeRowView({ body: 'DRep', tier: t, buckets: b, list, comparison: null, actionHref: HREF }));
    expect(v.list?.rows).toEqual([
      {
        name: 'drep1bbbb...bbbbbbbb',
        stanceLabel: 'Not voted',
        powerLabel: '20 ₳',
        countsLabel: null,
        href: '/dreps/drep1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/',
      },
      {
        name: 'Nora',
        stanceLabel: 'No',
        powerLabel: '15 ₳',
        countsLabel: null,
        href: `${HREF}?tab=positions&voter=drep1cccccccccccccccccccccccccccccc#voter-drep1cccccccccccccccccccccccccccccc`,
      },
    ]);
    const withAbstain = fewestToPass(cands, t, ['Abstain'], b.Dv);
    const a = keep(stakeRowView({ body: 'DRep', tier: t, buckets: b, list: withAbstain, comparison: null, actionHref: HREF }));
    expect(a.list).toBeNull();
    const ab = fewestToPass([cands[0], cand('drep1dd', 30n * ADA, 'Abstain')], t, ['Abstain'], 0n);
    const v2 = keep(stakeRowView({ body: 'DRep', tier: t, buckets: b, list: ab, comparison: null, actionHref: HREF }));
    expect(v2.list?.rows[0]).toMatchObject({ stanceLabel: 'Abstain', countsLabel: 'counts 15 ₳' });
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
    const same = fewestToPass(pool, tt, ['notVoted', 'Abstain', 'No'], 0n);
    const one = fewestToPass([pool[2]], tt, ['notVoted', 'Abstain', 'No'], 0n);
    expect(stakeRowView({ body: 'DRep', tier: tt, buckets: bb, list: one, comparison: same, actionHref: HREF }).list?.comparison).toBeNull();
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

describe('copy rules', () => {
  it('no dashes, semicolons or lands anywhere', () => {
    const all = [...produced, PASS_PATH_FOOTNOTE, PASS_LIST_FOOTNOTE];
    expect(produced.length).toBeGreaterThan(10);
    for (const s of all) expect(s).not.toMatch(/[—–―;]|&mdash;|&ndash;|\blands?\b/);
  });
});
