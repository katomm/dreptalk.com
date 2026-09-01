import { describe, expect, it } from 'vitest';
import { buildRationaleCoverage } from './rationaleCoverageView.js';
import type { ActionRationaleCoverage } from '../db/rationaleCoverage.js';

const a = (over: Partial<ActionRationaleCoverage>): ActionRationaleCoverage => ({
  gaId: 'ga1', title: 'T', topicSlug: 'slug', type: 'InfoAction', decidedEpoch: 600,
  votes: 40, withRationale: 20, votesWithPower: 40, power: '1000', powerWithRationale: '600',
  ...over,
});

describe('buildRationaleCoverage', () => {
  it('computes count and power coverage with completeness gating', () => {
    const v = buildRationaleCoverage([
      a({ gaId: 'g1' }),
      a({ gaId: 'g2', votes: 60, withRationale: 30, votesWithPower: 59, power: null, powerWithRationale: null }),
    ], 5);
    expect(v.totalVotes).toBe(100);
    expect(v.totalWithRationale).toBe(50);
    expect(v.countPct).toBe(50);
    // Power figure over g1 only: 600/1000.
    expect(v.powerPct).toBe(60);
    expect(v.powerExcluded).toBe(1);
    expect(v.revoteAdded).toBe(5);
  });

  it('handles power sums beyond 2^53 via BigInt', () => {
    // 2^53+2 total, 2^53+1 covered: Number math would round both to the same
    // value and report 100%. BigInt keeps the one-lovelace gap.
    const v = buildRationaleCoverage([
      a({ gaId: 'g1', power: '9007199254740994', powerWithRationale: '9007199254740993' }),
    ], 0);
    expect(v.powerPct).toBe(99.9999);
  });

  it('excludes a malformed power value without dropping the rest of the total', () => {
    const v = buildRationaleCoverage([
      a({ gaId: 'g1', power: '1000', powerWithRationale: '600' }),
      a({ gaId: 'g2', power: '100', powerWithRationale: 'x' }),
    ], 0);
    expect(v.powerPct).toBe(60);
    expect(v.powerExcluded).toBe(1);
  });

  it('builds per-type medians and the per-epoch series', () => {
    const v = buildRationaleCoverage([
      a({ gaId: 'g1', type: 'InfoAction', votes: 40, withRationale: 40, decidedEpoch: 600 }),
      a({ gaId: 'g2', type: 'InfoAction', votes: 40, withRationale: 0, decidedEpoch: 600 }),
      a({ gaId: 'g3', type: 'TreasuryWithdrawals', votes: 40, withRationale: 10, decidedEpoch: 601 }),
    ], 0);
    const info = v.byType.find((t) => t.type === 'InfoAction');
    expect(info).toMatchObject({ medianPct: 50, actions: 2 });
    expect(v.epochSeries).toEqual([
      { epoch: 600, value: 50 },
      { epoch: 601, value: 25 },
    ]);
  });

  it('applies the 20-vote floor to best and worst and counts exclusions', () => {
    const rows = [
      a({ gaId: 'g1', votes: 40, withRationale: 36 }),
      a({ gaId: 'g2', votes: 40, withRationale: 4 }),
      a({ gaId: 'g3', votes: 5, withRationale: 5 }),
    ];
    const v = buildRationaleCoverage(rows, 0);
    expect(v.best[0].gaId).toBe('g1');
    expect(v.best[0].pct).toBe(90);
    expect(v.worst[0].gaId).toBe('g2');
    expect(v.belowFloor).toBe(1);
    expect(v.best.some((x) => x.gaId === 'g3')).toBe(false);
  });

  it('returns nulls and empties for no input', () => {
    const v = buildRationaleCoverage([], 0);
    expect(v.countPct).toBeNull();
    expect(v.powerPct).toBeNull();
    expect(v.best).toEqual([]);
    expect(v.epochSeries).toEqual([]);
  });
});
