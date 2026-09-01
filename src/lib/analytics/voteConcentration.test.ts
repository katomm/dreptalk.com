import { describe, expect, it } from 'vitest';
import { buildVoteConcentration, requiredYesPower } from './voteConcentration.js';

describe('buildVoteConcentration', () => {
  it('returns null for an empty vote set', () => {
    expect(buildVoteConcentration([], null)).toBeNull();
  });

  it('returns null when any voted power is missing (completeness rule)', () => {
    expect(buildVoteConcentration([100, null, 50], null)).toBeNull();
  });

  it('handles a single voter', () => {
    const v = buildVoteConcentration([1000], null);
    expect(v).not.toBeNull();
    expect(v?.voterCount).toBe(1);
    expect(v?.halfCount).toBe(1);
    expect(v?.largestPct).toBe(100);
    expect(v?.top5Pct).toBeNull();
    expect(v?.thresholdCount).toBeNull();
  });

  it('computes half-count with an exact 50% boundary counting as reached', () => {
    // 50 + 30 + 20: the largest voter holds exactly 50% of 100.
    const v = buildVoteConcentration([30, 50, 20], null);
    expect(v?.halfCount).toBe(1);
    expect(v?.voterCount).toBe(3);
    expect(v?.largestPct).toBe(50);
  });

  it('needs two voters when the largest is just under half', () => {
    const v = buildVoteConcentration([49, 31, 20], null);
    expect(v?.halfCount).toBe(2);
  });

  it('gates top5Pct on more than five voters', () => {
    expect(buildVoteConcentration([5, 4, 3, 2, 1], null)?.top5Pct).toBeNull();
    const v = buildVoteConcentration([50, 20, 10, 8, 6, 6], null);
    // top 5 = 94 of 100
    expect(v?.top5Pct).toBe(94);
  });

  it('computes thresholdCount from the largest voters', () => {
    // required 60 of 100 total: 50 alone misses, 50+30 crosses.
    const v = buildVoteConcentration([50, 30, 20], 60n);
    expect(v?.thresholdCount).toBe(2);
  });

  it('leaves thresholdCount null when all voters together fall short', () => {
    const v = buildVoteConcentration([50, 30, 20], 101n);
    expect(v?.thresholdCount).toBeNull();
  });

  it('leaves thresholdCount null without a required power', () => {
    expect(buildVoteConcentration([50, 30, 20], null)?.thresholdCount).toBeNull();
  });

  it('returns null when every voted power is zero', () => {
    expect(buildVoteConcentration([0, 0, 0], null)).toBeNull();
  });

  it('stays exact beyond 2^53 total via BigInt sums', () => {
    // Two voters of 4.6e15 lovelace each: the sum exceeds Number.MAX_SAFE_INTEGER.
    const big = 4_600_000_000_000_000;
    const v = buildVoteConcentration([big, big, big], null);
    expect(v?.votedPower).toBe(13_800_000_000_000_000n);
    expect(v?.halfCount).toBe(2);
    expect(v?.largestPct).toBeCloseTo(33.3333, 3);
  });
});

describe('requiredYesPower', () => {
  it('scales the ratification denominator (yes plus the No side) by the threshold', () => {
    // activeYes 300, noSide 500 -> counted 800, 67% -> 536
    expect(requiredYesPower(300, '500', 67)).toBe(536n);
  });

  it('handles a fractional threshold percent exactly', () => {
    // no active yes yet, noSide 10000, 60.5% -> 6050
    expect(requiredYesPower(null, '10000', 60.5)).toBe(6050n);
  });

  it('returns null when any input is missing', () => {
    expect(requiredYesPower(300, null, 67)).toBeNull();
    expect(requiredYesPower(300, '500', null)).toBeNull();
  });

  it('returns null on malformed stored text', () => {
    expect(requiredYesPower(300, 'not-a-number', 67)).toBeNull();
  });

  it('returns null when the denominator is not positive', () => {
    expect(requiredYesPower(null, '0', 67)).toBeNull();
  });
});
