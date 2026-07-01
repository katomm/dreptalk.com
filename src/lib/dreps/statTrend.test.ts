import { describe, it, expect } from 'vitest';
import { computeDrepStatTrends } from './statTrend.js';

const agg = (epoch: number, count: number, total: number) => ({ epoch, count, total });

describe('computeDrepStatTrends', () => {
  it('reports the count change as an absolute, direction-tagged label', () => {
    const t = computeDrepStatTrends(agg(535, 1246, 1000), agg(534, 1234, 1000));
    expect(t.activeDreps).toEqual({ direction: 'up', label: '12' });
  });

  it('reports a shrinking DRep count as a down delta with an unsigned label', () => {
    const t = computeDrepStatTrends(agg(535, 1200, 1000), agg(534, 1234, 1000));
    expect(t.activeDreps).toEqual({ direction: 'down', label: '34' });
  });

  it('reports total voting power as a relative percent', () => {
    const t = computeDrepStatTrends(agg(535, 10, 10870), agg(534, 10, 10000));
    expect(t.totalPower).toEqual({ direction: 'up', label: '8.7%' });
  });

  it('reports average voting power per DRep independently of the total', () => {
    // Total flat but the count fell, so the average per DRep rose.
    const t = computeDrepStatTrends(agg(535, 8, 1000), agg(534, 10, 1000));
    expect(t.avgPower?.direction).toBe('up');
    expect(t.avgPower?.label).toBe('25.0%');
  });

  it('marks an unchanged metric as flat', () => {
    const t = computeDrepStatTrends(agg(535, 100, 1000), agg(534, 100, 1000));
    expect(t.activeDreps?.direction).toBe('flat');
    expect(t.totalPower?.direction).toBe('flat');
  });

  it('omits a percent trend when the previous base was zero', () => {
    const t = computeDrepStatTrends(agg(535, 5, 1000), agg(534, 0, 0));
    expect(t.totalPower).toBeNull();
    expect(t.avgPower).toBeNull();
    // The count still has a well-defined absolute delta.
    expect(t.activeDreps).toEqual({ direction: 'up', label: '5' });
  });

  it('returns all-null when only one epoch has synced', () => {
    expect(computeDrepStatTrends(agg(535, 100, 1000), undefined)).toEqual({
      activeDreps: null,
      totalPower: null,
      avgPower: null,
    });
    expect(computeDrepStatTrends(undefined, undefined)).toEqual({
      activeDreps: null,
      totalPower: null,
      avgPower: null,
    });
  });
});
