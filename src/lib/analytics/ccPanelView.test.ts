import { describe, expect, it } from 'vitest';
import { buildCcPanel, interimCommittee, selectExtremes } from './ccPanelView.js';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CcVoteRow, DecidedCcAction } from '../db/committee.js';

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
    // Both actions were decided at epoch 600, considered in gaId order.
    expect(v.actionEpochs).toEqual([600, 600]);
    // cold1 voted Yes on both, cold2 voted No on ga1 (still counted voted) then missed ga2.
    expect(alice?.sequence).toEqual(['voted', 'voted']);
    expect(other?.sequence).toEqual(['voted', 'missed']);
    // Both members hold an open, still-current term from epoch 500.
    expect(alice?.tenure).toEqual({ from: 500, to: null });
    expect(other?.tenure).toEqual({ from: 500, to: null });
  });

  it('marks a member ineligible for actions decided after its term expired, and closes its tenure', () => {
    const endedMembers: CommitteeMemberTerm[] = [
      { coldKeyHex: 'cold1', versionFrom: 500, versionTo: null, termExpiration: 610, authorizedFrom: 500, resignedAt: null },
      { coldKeyHex: 'cold2', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
    ];
    const actions = [
      action({ gaId: 'ga1', decidedEpoch: 600 }),
      action({ gaId: 'ga2', decidedEpoch: 620 }),
    ];
    const votesByAction = new Map([
      ['ga1', [vote('hot1', 'Yes', 2 * DAY), vote('hot2', 'Yes', 2 * DAY)]],
      ['ga2', [vote('hot2', 'Yes', 2 * DAY)]],
    ]);
    const v = buildCcPanel({ actions, votesByAction, members: endedMembers, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.considered).toBe(2);
    expect(v.actionEpochs).toEqual([600, 620]);
    const cold1 = v.members.find((m) => m.coldKeyHex === 'cold1');
    expect(cold1?.sequence).toEqual(['voted', 'ineligible']);
    expect(cold1?.tenure).toEqual({ from: 500, to: 610 });
    const cold2 = v.members.find((m) => m.coldKeyHex === 'cold2');
    expect(cold2?.sequence).toEqual(['voted', 'voted']);
    expect(cold2?.tenure).toEqual({ from: 500, to: null });
  });

  it('closes tenure at the version end, the resignation, or the expiration, whichever comes first', () => {
    // Three terms like a real multi-version member: dropped from the version
    // at 601 despite a far expiration, then resigned mid-term at 597 in the
    // shape the Atlantic Council left, so the tenure ends at 596.
    const multi: CommitteeMemberTerm[] = [
      { coldKeyHex: 'cold1', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 507, resignedAt: null },
      { coldKeyHex: 'cold1', versionFrom: 581, versionTo: 601, termExpiration: 726, authorizedFrom: 581, resignedAt: 597 },
      { coldKeyHex: 'cold2', versionFrom: 581, versionTo: 601, termExpiration: 726, authorizedFrom: 581, resignedAt: null },
      { coldKeyHex: 'cold2', versionFrom: 602, versionTo: null, termExpiration: 726, authorizedFrom: 602, resignedAt: null },
    ];
    // A skipped action (decided before any member existed) sits between two
    // considered ones and must not consume a sequence index.
    const actions = [
      action({ gaId: 'ga1', decidedEpoch: 590 }),
      action({ gaId: 'ga0', decidedEpoch: 400 }),
      action({ gaId: 'ga2', decidedEpoch: 610 }),
    ];
    const votesByAction = new Map([
      ['ga1', [vote('hot1', 'Yes', 2 * DAY), vote('hot2', 'Yes', 2 * DAY)]],
      ['ga2', [vote('hot2', 'Yes', 2 * DAY)]],
    ]);
    const v = buildCcPanel({ actions, votesByAction, members: multi, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.skipped).toBe(1);
    expect(v.actionEpochs).toEqual([590, 610]);
    const cold1 = v.members.find((m) => m.coldKeyHex === 'cold1');
    expect(cold1?.tenure).toEqual({ from: 507, to: 596 });
    expect(cold1?.sequence).toEqual(['voted', 'ineligible']);
    const cold2 = v.members.find((m) => m.coldKeyHex === 'cold2');
    expect(cold2?.tenure).toEqual({ from: 581, to: null });
    expect(cold2?.sequence).toEqual(['voted', 'voted']);
  });

  it('ends a dropped member at the committee version end, not its far expiration', () => {
    const dropped: CommitteeMemberTerm[] = [
      { coldKeyHex: 'cold1', versionFrom: 581, versionTo: 601, termExpiration: 726, authorizedFrom: 581, resignedAt: null },
    ];
    const v = buildCcPanel({ actions: [action({ gaId: 'ga1', decidedEpoch: 590 })], votesByAction: new Map(), members: dropped, hotToCold, nameIndex, currentEpoch: 650 });
    expect(v.members[0]?.tenure).toEqual({ from: 581, to: 601 });
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

describe('selectExtremes', () => {
  it('splits a longer list into top n and the last n, both in original order', () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    const { top, bottom, total } = selectExtremes(rows, 5);
    expect(top).toEqual([0, 1, 2, 3, 4]);
    expect(bottom).toEqual([7, 8, 9, 10, 11]);
    expect(total).toBe(12);
  });

  it('keeps everything as top with an empty bottom when the list is 2n or smaller', () => {
    const rows = Array.from({ length: 8 }, (_, i) => i);
    const { top, bottom, total } = selectExtremes(rows, 5);
    expect(top).toEqual(rows);
    expect(bottom).toEqual([]);
    expect(total).toBe(8);
  });
});

describe('interimCommittee', () => {
  const term = (over: Partial<CommitteeMemberTerm>): CommitteeMemberTerm => ({
    coldKeyHex: 'cold', versionFrom: 507, versionTo: 580, termExpiration: 580, authorizedFrom: 507, resignedAt: null,
    ...over,
  });

  it('ends with the earliest membership version and counts who carried on', () => {
    expect(
      interimCommittee([
        term({ coldKeyHex: 'a' }),
        term({ coldKeyHex: 'b' }),
        term({ coldKeyHex: 'a', versionFrom: 581, versionTo: null, termExpiration: 726 }),
        term({ coldKeyHex: 'c', versionFrom: 581, versionTo: null, termExpiration: 726 }),
      ]),
    ).toEqual({ end: 580, carryOver: 1 });
  });

  it('counts a member carried across two later versions once', () => {
    expect(
      interimCommittee([
        term({ coldKeyHex: 'a' }),
        term({ coldKeyHex: 'a', versionFrom: 581, versionTo: 601, termExpiration: 653 }),
        term({ coldKeyHex: 'a', versionFrom: 602, versionTo: null, termExpiration: 653 }),
      ]),
    ).toEqual({ end: 580, carryOver: 1 });
  });

  it('has no end while the first committee has never been replaced', () => {
    expect(interimCommittee([term({ versionTo: null })])).toEqual({ end: null, carryOver: 0 });
    expect(interimCommittee([])).toEqual({ end: null, carryOver: 0 });
  });

  it('ignores later versions when deciding the boundary', () => {
    // A second replacement must not move the interim boundary forward.
    expect(
      interimCommittee([
        term({}),
        term({ coldKeyHex: 'x', versionFrom: 581, versionTo: 601, termExpiration: 653 }),
        term({ coldKeyHex: 'x', versionFrom: 602, versionTo: null, termExpiration: 653 }),
      ]).end,
    ).toBe(580);
  });
});
