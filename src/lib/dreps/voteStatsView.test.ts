import { describe, it, expect } from 'vitest';
import { buildVoteDonut, rationaleStat, participationStat, voteChangeStat, voteTimingStat } from './voteStatsView.js';

const DAY = 86_400;

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

describe('voteTimingStat', () => {
  it('converts millisecond submission times against second vote times', () => {
    // submitted_at is stored in unix milliseconds, block_time in unix seconds.
    const rows = [{ blockTime: 3 * DAY, submittedAt: 1 * DAY * 1000 }];
    expect(voteTimingStat(rows)).toEqual({ medianDay: 2, timed: 1 });
  });

  it('returns the median of an even count', () => {
    const rows = [
      { blockTime: 2 * DAY, submittedAt: 0 },
      { blockTime: 4 * DAY, submittedAt: 0 },
    ];
    expect(voteTimingStat(rows)).toEqual({ medianDay: 3, timed: 2 });
  });

  it('skips a negative day (vote timestamp predates the action submission)', () => {
    const rows = [
      { blockTime: 1 * DAY, submittedAt: 5 * DAY * 1000 }, // would be -4 days
      { blockTime: 3 * DAY, submittedAt: 1 * DAY * 1000 }, // 2 days
    ];
    expect(voteTimingStat(rows)).toEqual({ medianDay: 2, timed: 1 });
  });

  it('returns null with no usable rows', () => {
    expect(voteTimingStat([])).toBeNull();
  });

  it('returns null when every row is negative', () => {
    const rows = [{ blockTime: 1 * DAY, submittedAt: 5 * DAY * 1000 }];
    expect(voteTimingStat(rows)).toBeNull();
  });
});

describe('voteChangeStat', () => {
  const earlier = (...votes: string[]) => votes.map((vote) => ({ vote })); // newest first, like the map

  it('counts real switches per action and in total', () => {
    // Action a, oldest to newest: No then current Yes = 1 change.
    // Action b, oldest to newest: Yes, No, current Yes = 2 changes
    // (the map is newest first, so superseded [No, Yes]).
    const stat = voteChangeStat(
      new Map([
        ['a', earlier('No')],
        ['b', earlier('No', 'Yes')],
      ]),
      new Map([
        ['a', 'Yes'],
        ['b', 'Yes'],
      ]),
    );
    expect(stat).toEqual({ actionsChanged: 2, totalChanges: 3 });
  });

  it('a same-choice re-vote (rationale revision) is not a change', () => {
    expect(
      voteChangeStat(new Map([['a', earlier('Yes')]]), new Map([['a', 'Yes']])),
    ).toEqual({ actionsChanged: 0, totalChanges: 0 });
  });

  it('mixes revisions and real changes correctly', () => {
    // Chain oldest-to-newest: Yes, Yes (revision), No (change) = 1 change.
    const stat = voteChangeStat(
      new Map([['a', earlier('Yes', 'Yes')]]),
      new Map([['a', 'No']]),
    );
    expect(stat).toEqual({ actionsChanged: 1, totalChanges: 1 });
  });

  it('handles an action beyond the loaded history rows (no current vote)', () => {
    // Only superseded votes known: No then Yes superseded = 1 change among them.
    const stat = voteChangeStat(new Map([['a', earlier('Yes', 'No')]]), new Map());
    expect(stat).toEqual({ actionsChanged: 1, totalChanges: 1 });
  });

  it('returns explicit zeros with no history at all', () => {
    expect(voteChangeStat(new Map(), new Map())).toEqual({ actionsChanged: 0, totalChanges: 0 });
  });
});
