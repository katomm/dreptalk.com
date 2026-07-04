import { describe, it, expect } from 'vitest';
import { NCL_PERIODS, getNclPeriod } from './ncl-periods.js';

describe('NCL_PERIODS', () => {
  it('has positive ceilings and valid windows', () => {
    for (const p of NCL_PERIODS) {
      expect(p.ceilingLovelace > 0n).toBe(true);
      expect(p.endEpoch).toBeGreaterThanOrEqual(p.startEpoch);
      expect(p.definingActionIds.length).toBeGreaterThan(0);
    }
  });

  it('windows are ordered and non-overlapping', () => {
    const sorted = [...NCL_PERIODS].sort((a, b) => a.startEpoch - b.startEpoch);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startEpoch).toBeGreaterThan(sorted[i - 1].endEpoch);
    }
  });

  it('resolves a period by id', () => {
    expect(getNclPeriod('2026-27')?.ceilingLovelace).toBe(350_000_000_000_000n);
    expect(getNclPeriod('nope')).toBeUndefined();
  });
});
