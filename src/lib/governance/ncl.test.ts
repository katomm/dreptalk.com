import { describe, it, expect } from 'vitest';
import { nclStatusFor, currentNclPeriod, nclLifecycle, type Withdrawal } from './ncl.js';
import type { NclPeriod } from '../../../config/ncl-periods.js';

const period: NclPeriod = {
  id: 't', label: 'T', ceilingLovelace: 100n, startEpoch: 10, endEpoch: 20,
  definingActionIds: ['x#0'], relatedActionIds: [],
};

const wd = (enactedEpoch: number, lovelace: bigint): Withdrawal => ({ enactedEpoch, lovelace });

describe('nclLifecycle', () => {
  it('classifies by current epoch with inclusive bounds', () => {
    expect(nclLifecycle(period, 5)).toBe('upcoming');
    expect(nclLifecycle(period, 10)).toBe('active');
    expect(nclLifecycle(period, 20)).toBe('active');
    expect(nclLifecycle(period, 21)).toBe('completed');
    expect(nclLifecycle(period, null)).toBe('active');
  });
});

describe('nclStatusFor', () => {
  it('sums only withdrawals inside the window', () => {
    const s = nclStatusFor(period, [wd(9, 50n), wd(10, 30n), wd(20, 10n), wd(21, 99n)]);
    expect(s.consumedLovelace).toBe(40n);
    expect(s.withdrawalCount).toBe(2);
    expect(s.remainingLovelace).toBe(60n);
    expect(s.consumedPct).toBe(40);
    expect(s.remainingPct).toBe(60);
    expect(s.overBudget).toBe(false);
  });

  it('floors remaining at 0 and flags overBudget', () => {
    const s = nclStatusFor(period, [wd(12, 120n)]);
    expect(s.remainingLovelace).toBe(0n);
    expect(s.overBudget).toBe(true);
    expect(s.consumedPct).toBe(120);
    expect(s.remainingPct).toBe(0);
  });
});

describe('currentNclPeriod', () => {
  it('selects the period whose window contains the epoch', () => {
    const a = { ...period, id: 'a', startEpoch: 10, endEpoch: 20 };
    const b = { ...period, id: 'b', startEpoch: 21, endEpoch: 30 };
    expect(currentNclPeriod([a, b], 25)?.id).toBe('b');
    expect(currentNclPeriod([a, b], 5)).toBeUndefined();
  });
});
