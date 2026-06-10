import { describe, it, expect } from 'vitest';
import { buildVoteDonut, formatRationale, formatParticipation } from './voteStatsView.js';

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

describe('formatRationale', () => {
  it('formats the rationale rate', () => {
    expect(formatRationale({ total: 41, withRationale: 27 })).toBe('27 of 41 votes with rationale (66%)');
  });
  it('returns null with no votes', () => {
    expect(formatRationale({ total: 0, withRationale: 0 })).toBeNull();
  });
});

describe('formatParticipation', () => {
  it('formats the participation rate', () => {
    expect(formatParticipation({ eligible: 22, voted: 18 })).toBe('Voted on 18 of 22 eligible actions (82%)');
  });
  it('shows pending when the registration epoch is unknown', () => {
    expect(formatParticipation(null)).toBe('Registration date pending');
  });
  it('shows a no-actions note instead of 0%', () => {
    expect(formatParticipation({ eligible: 0, voted: 0 })).toBe('No concluded governance actions yet');
  });
});
