import { describe, it, expect } from 'vitest';
import fixture from './__fixtures__/poolEconomics660.json';
import {
  budget,
  economicsFromJson,
  minPoolCostImpact,
  modelParams,
  rewardChange,
  rewardCurves,
  samplePools,
  saturation,
  type PoolEconomicsJson,
} from './paramImpact.js';

const eco = economicsFromJson(fixture as PoolEconomicsJson);
const now = { k: 500, a0: 0.3, rho: 0.003, tau: 0.2 };
const r = (n: bigint, d: bigint) => ({ n, d });

describe('economicsFromJson', () => {
  it('reads the mainnet epoch 660 snapshot', () => {
    expect(eco.epoch).toBe(660);
    expect(eco.pools).toHaveLength(2669);
    expect(eco.totalStakeAda).toBeCloseTo(38_922_094_969.54, 0);
    expect(eco.pools[0].stake).toBeGreaterThanOrEqual(eco.pools[1].stake);
  });
});

describe('saturation', () => {
  it('matches the spec anchor for k 600', () => {
    const s = saturation(eco, 500, 600);
    expect(s.pointFrom / 1e6).toBeCloseTo(77.844, 2);
    expect(s.pointTo / 1e6).toBeCloseTo(64.870, 2);
    expect(s.aboveFrom).toBe(5);
    expect(s.aboveTo).toBe(101);
    expect(s.excessTo / 1e9).toBeCloseTo(0.875, 2);
  });
  it('sums the stake over the old point too', () => {
    const s = saturation(eco, 500, 600);
    expect(s.excessFrom / 1e6).toBeCloseTo(103.74, 1);
    // An unchanged k gives the same excess before and after.
    const same = saturation(eco, 500, 500);
    expect(same.excessFrom).toBe(same.excessTo);
  });
});

describe('rewardChange', () => {
  const pkg = { ...now, k: 600, a0: 0.35 };
  it('matches the spec anchors for the package k 600 and a0 0.35', () => {
    expect(rewardChange(eco, now, pkg, 30e6, 1e6) * 100).toBeCloseTo(-3.56, 1);
    expect(rewardChange(eco, now, pkg, 60e6, 30e6) * 100).toBeCloseTo(0.96, 1);
  });
  it('shows that k alone moves pools below saturation through the pledge term', () => {
    expect(rewardChange(eco, now, { ...now, k: 600 }, 30e6, 10e6) * 100).toBeCloseTo(0.71, 1);
  });
  it('includes a changed reward pot', () => {
    expect(rewardChange(eco, now, { ...pkg, tau: 0.3 }, 60e6, 30e6) * 100).toBeCloseTo(-11.66, 1);
  });
  it('gives three curves over a stake range relative to the saturation point', () => {
    const { xMin, xMax, pointFrom, pointTo, curves } = rewardCurves(eco, now, pkg);
    expect(pointTo).toBeCloseTo(eco.totalStakeAda / 600, 3);
    // 2% of the new point to 1.5 times the higher, old point.
    expect(xMin / 1e6).toBeCloseTo(1.297, 2);
    expect(xMax / 1e6).toBeCloseTo(116.766, 2);
    expect(xMax).toBeCloseTo(1.5 * pointFrom, 3);
    expect(curves.map((c) => c.pledge)).toEqual([1e6, 10e6, 30e6]);
    // A curve starts at its pledge, or at the range start when the pledge is below it.
    expect(curves[0].points[0][0]).toBeCloseTo(xMin, 3);
    expect(curves[2].points[0][0]).toBe(30e6);
    for (const c of curves) expect(c.points.at(-1)![0]).toBeCloseTo(xMax, 3);
    // Both saturation points are sampled, so the kink is drawn where it is.
    expect(curves[1].points.some(([stake]) => stake === pointTo)).toBe(true);
    expect(curves[1].points.some(([stake]) => stake === pointFrom)).toBe(true);
  });
  it('drops a curve whose pledge lies beyond the stake range', () => {
    // 8B ada of stake and k 600: the range ends at 1.5 times 16M, so the 30M pledge has no curve.
    const tiny = { ...eco, totalStakeAda: 8e9 };
    expect(rewardCurves(tiny, now, { ...now, k: 600 }).curves.map((c) => c.pledge)).toEqual([1e6, 10e6]);
  });
});

describe('samplePools', () => {
  it('places the three reference pools relative to the new saturation point', () => {
    const point = eco.totalStakeAda / 600;
    const [small, pledged, near] = samplePools(eco, 600);
    expect(small.stake / 1e6).toBeCloseTo(32.435, 2);
    expect(small).toEqual({ stake: point / 2, pledge: 1e6 });
    expect(pledged.stake).toBe(point / 2);
    expect(pledged.pledge / 1e6).toBeCloseTo(9.731, 2);
    expect(near.stake / 1e6).toBeCloseTo(58.383, 2);
    expect(near.pledge).toBeCloseTo(0.3 * near.stake, 3);
  });
  it('gives the package k 600 and a0 0.35 for the three pools', () => {
    const pkg = { ...now, k: 600, a0: 0.35 };
    const changes = samplePools(eco, 600).map((p) => rewardChange(eco, now, pkg, p.stake, p.pledge) * 100);
    expect(changes[0]).toBeCloseTo(-3.56, 1);
    expect(changes[1]).toBeCloseTo(-2.43, 1);
    expect(changes[2]).toBeCloseTo(-1.05, 1);
  });
  it('never gives a pledge above the stake', () => {
    const tiny = { ...eco, totalStakeAda: 500e6 };
    const [small] = samplePools(tiny, 600);
    expect(small.pledge).toBe(small.stake);
  });
});

describe('minPoolCostImpact', () => {
  it('compares fixed costs exactly in lovelace', () => {
    expect(minPoolCostImpact(eco, 170_000_000n, 170_000_000n).below).toBe(0);
    expect(minPoolCostImpact(eco, 170_000_000n, 170_000_001n).below).toBe(500);
    expect(minPoolCostImpact(eco, 170_000_000n, 340_000_000n).below).toBe(556);
  });
  it('counts the pools at exactly the current minimum', () => {
    expect(minPoolCostImpact(eco, 170_000_000n, 200_000_000n).atCurrent).toBe(500);
    expect(minPoolCostImpact(eco, 170_000_001n, 200_000_000n).atCurrent).toBe(0);
  });
  it('bins fixed costs in 25 ada steps up to 500 ada plus one open bin', () => {
    const { bins } = minPoolCostImpact(eco, 170_000_000n, 200_000_000n);
    expect(bins).toHaveLength(21);
    expect(bins[0]).toMatchObject({ fromAda: 0, toAda: 25 });
    expect(bins[20]).toMatchObject({ fromAda: 500, toAda: null });
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(2669);
  });
});

describe('budget', () => {
  it('splits the reserve draw between treasury and stakers', () => {
    const b = budget(eco, now, now);
    expect(b.drawFrom / 1e6).toBeCloseTo(18.234, 2);
    expect(b.treasuryFrom / 1e6).toBeCloseTo(3.647, 2);
    expect(b.stakersFrom / 1e6).toBeCloseTo(14.587, 2);
  });
});

describe('modelParams', () => {
  it('takes the package value where there is one and the current value otherwise', () => {
    const current = { k: r(500n, 1n), a0: r(3n, 10n), rho: r(3n, 1000n), tau: r(1n, 5n) };
    expect(modelParams(current, { k: r(600n, 1n) })).toEqual({ from: now, to: { ...now, k: 600 } });
  });
  it('answers null while a current value is missing', () => {
    expect(modelParams({ k: r(500n, 1n) }, {})).toBeNull();
  });
});
