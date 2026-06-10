import { describe, it, expect } from 'vitest';
import { computeConcentration, type ConcentrationInput } from './concentration.js';

const mk = (id: string, power: bigint): ConcentrationInput => ({ drepId: id, name: id, power });

describe('computeConcentration', () => {
  it('returns an empty result for no DReps', () => {
    const c = computeConcentration([]);
    expect(c.drepCount).toBe(0);
    expect(c.topK).toEqual([]);
    expect(c.byPercent).toHaveLength(101);
    expect(c.byPercent[100]).toEqual({ count: 0, cumPct: 0 });
  });

  it('computes pct and a single-DRep coalition for a dominant DRep', () => {
    const c = computeConcentration([mk('a', 80n), mk('b', 20n)]);
    expect(c.topK[0].pct).toBe(80);
    expect(c.byPercent[67].count).toBe(1);
    expect(c.byPercent[80].count).toBe(1);
    expect(c.byPercent[81].count).toBe(2);
  });

  it('byPercent count is monotonic and reaches drepCount at 100%', () => {
    const c = computeConcentration([mk('a', 10n), mk('b', 10n), mk('c', 10n), mk('d', 10n)]);
    for (let p = 1; p <= 100; p++) {
      expect(c.byPercent[p].count).toBeGreaterThanOrEqual(c.byPercent[p - 1].count);
    }
    expect(c.byPercent[100].count).toBe(4);
  });

  it('treats null/negative power as zero', () => {
    const c = computeConcentration([mk('a', 100n), { drepId: 'b', name: 'b', power: -5n }]);
    expect(c.byPercent[100].count).toBe(1);
    expect(c.drepCount).toBe(2);
  });

  it('returns an empty-shaped result when all powers are non-positive', () => {
    const c = computeConcentration([mk('a', 0n), mk('b', -3n)]);
    expect(c.drepCount).toBe(2);
    expect(c.topK).toEqual([]);
    expect(c.byPercent[100]).toEqual({ count: 0, cumPct: 0 });
  });

  it('uses BigInt so large lovelace sums do not lose precision', () => {
    const big = 9_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER
    const c = computeConcentration([mk('a', big), mk('b', big)]);
    expect(c.byPercent[50].count).toBe(1);
    expect(c.byPercent[51].count).toBe(2);
  });
});
