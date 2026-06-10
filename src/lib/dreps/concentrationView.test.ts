import { describe, it, expect } from 'vitest';
import { coalitionAt, snapThreshold, buildSegments, summarySentence } from './concentrationView.js';
import type { ConcentrationPoint, ConcentrationTop } from './concentration.js';

describe('snapThreshold', () => {
  it('snaps to a nearby marker', () => {
    expect(snapThreshold(66, [60, 67, 75])).toBe(67);
  });
  it('leaves values far from any marker untouched', () => {
    expect(snapThreshold(50, [60, 67, 75])).toBe(50);
  });
});

describe('coalitionAt', () => {
  const byPercent: ConcentrationPoint[] = Array.from({ length: 101 }, (_, p) => ({ count: p, cumPct: p }));
  it('clamps and indexes by percent', () => {
    expect(coalitionAt(byPercent, 67)).toEqual({ count: 67, cumPct: 67 });
    expect(coalitionAt(byPercent, 200)).toEqual({ count: 100, cumPct: 100 });
  });
});

describe('buildSegments', () => {
  const topK: ConcentrationTop[] = [
    { drepId: 'a', name: 'A', powerLabel: '', pct: 30 },
    { drepId: 'b', name: 'B', powerLabel: '', pct: 25 },
    { drepId: 'c', name: 'C', powerLabel: '', pct: 20 },
  ];
  it('uses individual top slices when the coalition fits in top-K', () => {
    expect(buildSegments(topK, { count: 2, cumPct: 55 })).toEqual([
      { pct: 30, kind: 'top' },
      { pct: 25, kind: 'top' },
      { pct: 45, kind: 'remainder' },
    ]);
  });
  it('adds a coalitionRest slice when the coalition exceeds top-K', () => {
    expect(buildSegments(topK, { count: 5, cumPct: 90 })).toEqual([
      { pct: 30, kind: 'top' },
      { pct: 25, kind: 'top' },
      { pct: 20, kind: 'top' },
      { pct: 15, kind: 'coalitionRest' },
      { pct: 10, kind: 'remainder' },
    ]);
  });
});

describe('summarySentence', () => {
  it('formats count and percent', () => {
    expect(summarySentence(7, 67)).toBe('Top 7 DReps hold 67% of active DRep voting power');
  });
});
