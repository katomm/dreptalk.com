import { describe, it, expect } from 'vitest';
import { buildVoteDonut, rationaleStat, participationStat } from './voteStatsView.js';

describe('buildVoteDonut', () => {
  it('skips zero-count slices, keeps all three in the legend with percentages', () => {
    const d = buildVoteDonut({ yes: 3, no: 1, abstain: 0, total: 4 });
    expect(d.arcs.map((a) => a.key)).toEqual(['yes', 'no']); // abstain (0) skipped
    expect(d.arcs[0].offset).toBeCloseTo(0); // first arc starts at the top
    expect(d.legend.map((l) => l.pct)).toEqual([75, 25, 0]);
    expect(d.total).toBe(4);
  });

  it('returns no arcs when there are no votes', () => {
    const d = buildVoteDonut({ yes: 0, no: 0, abstain: 0, total: 0 });
    expect(d.arcs).toEqual([]);
    expect(d.legend.every((l) => l.count === 0 && l.pct === 0)).toBe(true);
  });
});

describe('rationaleStat', () => {
  it('returns the counts and the rounded percent', () => {
    expect(rationaleStat({ total: 41, withRationale: 27 })).toEqual({ withRationale: 27, total: 41, pct: 66 });
  });
  it('returns null with no votes', () => {
    expect(rationaleStat({ total: 0, withRationale: 0 })).toBeNull();
  });
});

describe('participationStat', () => {
  it('returns ok with the rounded percent', () => {
    expect(participationStat({ eligible: 22, voted: 18 })).toEqual({ kind: 'ok', voted: 18, eligible: 22, pct: 82 });
  });
  it('flags pending when the registration epoch is unknown', () => {
    expect(participationStat(null)).toEqual({ kind: 'pending' });
  });
  it('flags none when there are no concluded actions', () => {
    expect(participationStat({ eligible: 0, voted: 0 })).toEqual({ kind: 'none' });
  });
});
