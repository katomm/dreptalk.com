import { describe, expect, it } from 'vitest';
import { buildCcPanel } from './ccPanelView.js';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CcVoteRow } from '../db/committee.js';
import type { DecidedCcAction } from '../db/committee.js';

// Two members active from epoch 500 with long terms, cold1 votes, cold2 mostly not.
const members: CommitteeMemberTerm[] = [
  { coldKeyHex: 'cold1', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
  { coldKeyHex: 'cold2', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
];
const hotToCold = new Map([
  ['hot1', 'cold1'],
  ['hot2', 'cold2'],
]);
const nameIndex = { byHot: () => null, byCold: (c: string) => (c === 'cold1' ? 'Alice Org' : null) };

const action = (over: Partial<DecidedCcAction>): DecidedCcAction => ({
  gaId: 'ga1', title: 'T', topicSlug: null, type: 'InfoAction', decidedEpoch: 600,
  submittedAt: 0, ccYesPct: 100, thresholdsJson: '{"cc":66.7,"ccBelowMinSize":false,"v":2}',
  ...over,
});
const vote = (hot: string, v: 'Yes' | 'No' | 'Abstain', blockTime: number | null): CcVoteRow => ({
  voterId: hot, hotKeyHex: hot, vote: v, blockTime, metaUrl: null,
});

const DAY = 86_400;

describe('buildCcPanel', () => {
  it('aggregates turnout, split, verdicts, latency and members', () => {
    const actions = [
      action({ gaId: 'ga1' }),
      action({ gaId: 'ga2', ccYesPct: 50, submittedAt: 0 }),
      // Not CC eligible, must be ignored entirely.
      action({ gaId: 'ga3', type: 'NoConfidence' }),
    ];
    const votesByAction = new Map([
      ['ga1', [vote('hot1', 'Yes', 2 * DAY), vote('hot2', 'No', 4 * DAY)]],
      ['ga2', [vote('hot1', 'Yes', 6 * DAY)]],
    ]);
    const v = buildCcPanel({ actions, votesByAction, members, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.considered).toBe(2);
    expect(v.skipped).toBe(0);
    // Turnouts: ga1 2/2 = 100, ga2 1/2 = 50, median 75.
    expect(v.medianTurnoutPct).toBe(75);
    expect(v.splitCount).toBe(1);
    expect(v.verdictBasis).toBe(2);
    // ga2 ccYesPct 50 < 66.7 -> below threshold.
    expect(v.belowThreshold).toBe(1);
    // Latencies in days: 2, 4, 6 -> median 4.
    expect(v.medianLatencyDays).toBe(4);
    const alice = v.members.find((m) => m.coldKeyHex === 'cold1');
    expect(alice).toMatchObject({ name: 'Alice Org', voted: 2, eligible: 2, pct: 100 });
    const other = v.members.find((m) => m.coldKeyHex === 'cold2');
    expect(other).toMatchObject({ name: null, voted: 1, eligible: 2, pct: 50 });
    expect(v.members[0].coldKeyHex).toBe('cold1');
  });

  it('applies the quorum gate to the verdict', () => {
    const actions = [action({ gaId: 'ga1', ccYesPct: 100, thresholdsJson: '{"cc":66.7,"ccBelowMinSize":true,"v":2}' })];
    const v = buildCcPanel({ actions, votesByAction: new Map(), members, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.belowThreshold).toBe(1);
  });

  it('excludes actions without a usable verdict from the rate but not from turnout', () => {
    const actions = [action({ gaId: 'ga1', ccYesPct: null }), action({ gaId: 'ga2', thresholdsJson: null })];
    const v = buildCcPanel({ actions, votesByAction: new Map(), members, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.considered).toBe(2);
    expect(v.verdictBasis).toBe(0);
    expect(v.belowThreshold).toBe(0);
  });

  it('skips actions whose committee epoch resolves to no active set', () => {
    // decided before any member was active
    const actions = [action({ gaId: 'ga1', decidedEpoch: 400 })];
    const v = buildCcPanel({ actions, votesByAction: new Map(), members, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.considered).toBe(0);
    expect(v.skipped).toBe(1);
    expect(v.medianTurnoutPct).toBeNull();
    expect(v.members).toEqual([]);
  });

  it('ignores latency for votes without a block time or actions without submitted_at', () => {
    const actions = [action({ gaId: 'ga1', submittedAt: null })];
    const votesByAction = new Map([['ga1', [vote('hot1', 'Yes', 2 * DAY)]]]);
    const v = buildCcPanel({ actions, votesByAction, members, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.medianLatencyDays).toBeNull();
    expect(v.medianTurnoutPct).toBe(50);
  });

  it('converts millisecond submission times against second vote times', () => {
    // submitted_at is stored in unix milliseconds, vote block times in seconds.
    const actions = [action({ gaId: 'ga1', submittedAt: 1 * DAY * 1000 })];
    const votesByAction = new Map([['ga1', [vote('hot1', 'Yes', 3 * DAY)]]]);
    const v = buildCcPanel({ actions, votesByAction, members, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.medianLatencyDays).toBe(2);
  });
});
