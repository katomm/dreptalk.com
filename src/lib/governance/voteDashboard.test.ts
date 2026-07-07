import { describe, it, expect } from 'vitest';
import { isClosingSoon, deriveVoteStats, CLOSING_SOON_DAYS } from './voteDashboard.js';

describe('isClosingSoon', () => {
  it('is true at or under the threshold, false above it or when null', () => {
    expect(isClosingSoon(0)).toBe(true);
    expect(isClosingSoon(CLOSING_SOON_DAYS)).toBe(true);
    expect(isClosingSoon(CLOSING_SOON_DAYS + 1)).toBe(false);
    expect(isClosingSoon(null)).toBe(false);
  });
});

describe('deriveVoteStats', () => {
  it('counts open, not-voted and closing-soon independently', () => {
    const rows = [
      { voted: false, daysLeft: 1 },
      { voted: true, daysLeft: 1 },
      { voted: false, daysLeft: 10 },
      { voted: true, daysLeft: null },
    ];
    expect(deriveVoteStats(rows)).toEqual({ open: 4, notVoted: 2, closingSoon: 2 });
  });

  it('is all-zero for an empty list', () => {
    expect(deriveVoteStats([])).toEqual({ open: 0, notVoted: 0, closingSoon: 0 });
  });
});
