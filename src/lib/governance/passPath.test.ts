import { describe, expect, it } from 'vitest';
import { buildBodyStake, type BodyStakeView, type FullStakeSegmentKey } from './fullStakeView.js';
import {
  ccBlockedAtBoundary,
  ccSeatsToPass,
  drepBuckets,
  fewestToPass,
  reachTier,
  reconcileCandidates,
  spoBuckets,
  type PassCandidate,
  type StakeBuckets,
} from './passPath.js';

const S = 1_000_000n;

function buckets(b: Partial<StakeBuckets>): StakeBuckets {
  return { Y: 0n, N: 0n, Dv: 0n, Dx: 0n, F: 0n, A: 0n, ...b };
}

function fakeView(a: Partial<Record<FullStakeSegmentKey, bigint>>, aaCounted = false): BodyStakeView {
  const amounts: Record<FullStakeSegmentKey, bigint> = {
    yes: 0n,
    no: 0n,
    defaultNo: 0n,
    alwaysNoConfidence: 0n,
    activeAbstain: 0n,
    alwaysAbstain: 0n,
    ...a,
  };
  return { amounts, aaCounted } as unknown as BodyStakeView;
}

const cand = (drepId: string, power: bigint, stance: PassCandidate['stance']): PassCandidate => ({
  drepId,
  name: null,
  power,
  stance,
});

describe('reachTier', () => {
  it('worked example tier', () => {
    const b = buckets({
      Y: 179_743_473_702_240n,
      N: 1_195_684_661_096_741n,
      F: 131_032_384_710_853n,
      Dv: 2_511_376_514_744_646n,
      Dx: 2_512_202_966_284_460n - 2_511_376_514_744_646n,
      A: 786_647_989_205_958n,
    });
    expect(reachTier(b, 67)?.tier).toBe('abstainers');
    const all = { ...b, Dv: 2_512_202_966_284_460n, Dx: 0n };
    expect(reachTier(all, 67)?.tier).toBe('abstainers');
  });

  it('exact tie at t returns null', () => {
    expect(reachTier(buckets({ Y: 67n, N: 33n }), 67)).toBeNull();
  });

  it('returns null when nothing is counted', () => {
    expect(reachTier(buckets({ A: 100n }), 67)).toBeNull();
  });

  it('A-only rescue', () => {
    const t = reachTier(buckets({ Y: 60n, N: 40n, A: 100n }), 67)!;
    expect(t.tier).toBe('abstainers');
    expect(t.gapScaled).toBe(7n * S);
    expect(t.gapLovelace).toBe(7n);
    const r = fewestToPass([cand('drep_x', 100n, 'Abstain')], t, ['notVoted', 'Abstain'], 0n);
    expect(r.picks).toHaveLength(1);
    expect(r.reaches).toBe(true);
  });

  it('single abstainer exactly covers the gap', () => {
    const t = reachTier(buckets({ Y: 40n, N: 60n, A: 20n }), 50)!;
    expect(t.gapScaled).toBe(20n * (S - t.thrBp));
    const r = fewestToPass([cand('drep_x', 20n, 'Abstain')], t, ['notVoted', 'Abstain'], 0n);
    expect(r.picks).toHaveLength(1);
    expect(r.reaches).toBe(true);
  });

  it('fixed', () => {
    expect(reachTier(buckets({ F: 40n, Dv: 60n }), 67)?.tier).toBe('fixed');
  });

  it('noVoters', () => {
    expect(reachTier(buckets({ Y: 10n, N: 60n, Dv: 30n }), 67)?.tier).toBe('noVoters');
  });
});

describe('reconcileCandidates and fewestToPass', () => {
  it('list short of the gap inside tolerance', () => {
    const view = fakeView({ no: 67_000n, alwaysNoConfidence: 33_000n });
    const cands = [cand('drep_a', 40_000n, 'No'), cand('drep_b', 26_950n, 'No')];
    const rec = reconcileCandidates(cands, view);
    expect(rec.ok).toBe(true);
    const b = drepBuckets(view, rec.notVotedSum);
    const t = reachTier(b, 67)!;
    expect(t.tier).toBe('noVoters');
    expect(fewestToPass(cands, t, ['notVoted', 'Abstain', 'No'], b.Dv).reaches).toBe(false);
  });

  it('list capped at Dv', () => {
    const view = fakeView({ defaultNo: 202_700n, alwaysNoConfidence: 100_000n });
    const cands = [cand('drep_a', 150_000n, 'notVoted'), cand('drep_b', 52_900n, 'notVoted')];
    const rec = reconcileCandidates(cands, view);
    expect(rec.ok).toBe(true);
    const b = drepBuckets(view, rec.notVotedSum);
    expect(b.Dv).toBe(202_700n);
    const t = reachTier(b, 67)!;
    expect(t.tier).not.toBe('nonVoters');
    expect(fewestToPass(cands, t, ['notVoted'], 202_700n).reaches).toBe(false);
  });

  it('zero bucket passes only with zero candidates', () => {
    const view = fakeView({ no: 10n });
    expect(reconcileCandidates([cand('drep_a', 10n, 'No')], view).ok).toBe(true);
    expect(reconcileCandidates([cand('drep_a', 10n, 'No'), cand('drep_b', 5n, 'Abstain')], view).ok).toBe(false);
  });

  it('rejects a non-voter sum above the default No', () => {
    const view = fakeView({ defaultNo: 1_000n });
    expect(reconcileCandidates([cand('drep_a', 1_001n, 'notVoted')], view).ok).toBe(true);
    expect(reconcileCandidates([cand('drep_a', 1_002n, 'notVoted')], view).ok).toBe(false);
  });

  it('ties ordered by drepId', () => {
    const t = reachTier(buckets({ Y: 40n, N: 60n }), 50)!;
    const r = fewestToPass([cand('drep_b', 10n, 'No'), cand('drep_a', 10n, 'No')], t, ['No'], 0n);
    expect(r.picks.map((p) => p.drepId)).toEqual(['drep_a']);
    expect(r.reaches).toBe(true);
  });

  it('picks the largest worth first and counts abstainers at their reduced worth', () => {
    const t = reachTier(buckets({ Y: 40n, N: 60n, Dv: 30n, A: 50n }), 50)!;
    const r = fewestToPass(
      [cand('drep_a', 30n, 'Abstain'), cand('drep_b', 20n, 'notVoted'), cand('drep_c', 5n, 'notVoted')],
      t,
      ['notVoted', 'Abstain'],
      30n,
    );
    expect(r.picks.map((p) => p.drepId)).toEqual(['drep_b', 'drep_a']);
    expect(r.picks[0].worth).toBe(20n * S);
  });
});

describe('spoBuckets', () => {
  it('Hard Fork SPO only passive always-abstain', () => {
    const view = buildBodyStake({
      actionType: 'HardForkInitiation',
      body: 'SPO',
      activeYesPower: 40,
      activeNoPower: 0,
      activeAbstainPower: 0,
      noSidePower: '60',
      alwaysAbstainPower: '60',
      alwaysNoConfidencePower: '0',
      approvalThresholdPct: 51,
    })!;
    const b = spoBuckets(view);
    expect(b.Dv).toBe(60n);
    expect(reachTier(b, 51)?.tier).toBe('nonVoters');
  });

  it('SPO passive always-abstain outside hard fork', () => {
    const view = buildBodyStake({
      actionType: 'ParameterChange',
      body: 'SPO',
      activeYesPower: 40,
      activeNoPower: 60,
      activeAbstainPower: 0,
      noSidePower: '60',
      alwaysAbstainPower: '60',
      alwaysNoConfidencePower: '0',
      approvalThresholdPct: 51,
    })!;
    const b = spoBuckets(view);
    expect(b.A).toBe(60n);
    expect(b.Dv).toBe(0n);
    expect(reachTier(b, 51)?.tier).toBe('abstainers');
  });
});

describe('drepBuckets', () => {
  it('splits the default No into votable and inactive stake', () => {
    const view = fakeView({ yes: 5n, no: 6n, defaultNo: 100n, alwaysNoConfidence: 7n, activeAbstain: 8n, alwaysAbstain: 9n });
    expect(drepBuckets(view, 70n)).toEqual({ Y: 5n, N: 6n, Dv: 70n, Dx: 30n, F: 7n, A: 8n });
    expect(drepBuckets(view, 120n).Dv).toBe(100n);
  });
});

describe('ccSeatsToPass', () => {
  it('counts the boundary committee, without a member in their expiry epoch', () => {
    expect(ccSeatsToPass({ yes: 0, no: 0, abstain: 0, size: 6 }, 66.67)).toEqual({
      tier: 'nonVoters',
      extraYes: 4,
      notVoted: 6,
      size: 6,
    });
  });

  it('needs five of seven when nobody voted', () => {
    expect(ccSeatsToPass({ yes: 0, no: 0, abstain: 0, size: 7 }, 66.67)?.extraYes).toBe(5);
  });

  it('returns null when everyone abstained', () => {
    expect(ccSeatsToPass({ yes: 0, no: 0, abstain: 7, size: 7 }, 66.67)).toBeNull();
  });

  it('needs No voters when nobody is left to vote', () => {
    const t = ccSeatsToPass({ yes: 2, no: 5, abstain: 0, size: 7 }, 66.67)!;
    expect(t.tier).toBe('noVoters');
    expect(t.extraYes).toBe(3);
  });

  it('needs abstainers when non-voters cannot carry it', () => {
    const t = ccSeatsToPass({ yes: 3, no: 2, abstain: 2, size: 7 }, 66.67)!;
    expect(t).toEqual({ tier: 'abstainers', extraYes: 1, notVoted: 0, size: 7 });
    const u = ccSeatsToPass({ yes: 2, no: 0, abstain: 4, size: 7 }, 75)!;
    expect(u).toEqual({ tier: 'nonVoters', extraYes: 1, notVoted: 1, size: 7 });
    const w = ccSeatsToPass({ yes: 1, no: 1, abstain: 4, size: 7 }, 75)!;
    expect(w.tier).toBe('abstainers');
  });

  it('returns null when already met', () => {
    expect(ccSeatsToPass({ yes: 4, no: 0, abstain: 3, size: 7 }, 66.67)).toBeNull();
  });
});

describe('ccBlockedAtBoundary', () => {
  it('judges the minimum size at the boundary', () => {
    expect(ccBlockedAtBoundary(6, 7, false)).toBe(true);
    expect(ccBlockedAtBoundary(6, 6, false)).toBe(false);
    expect(ccBlockedAtBoundary(null, 7, true)).toBe(true);
    expect(ccBlockedAtBoundary(null, null, null)).toBe(false);
  });
});
