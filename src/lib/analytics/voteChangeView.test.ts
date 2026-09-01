import { describe, expect, it } from 'vitest';
import {
  buildActionVoteChanges,
  buildVoteChangeView,
  classifyNetChange,
  describeActionVoteChanges,
} from './voteChangeView.js';
import type { VoteChangeRow } from '../db/voteChangeStats.js';

const h = (voterRole: string, votesNewestFirst: string[]) =>
  votesNewestFirst.map((vote, i) => ({ vote, voter_role: voterRole, block_time: 100 - i }));

describe('classifyNetChange', () => {
  it('compares the earliest recorded vote with the current one', () => {
    expect(classifyNetChange([{ vote: 'No' }], 'Yes')).toBe('changed');
    expect(classifyNetChange([{ vote: 'Yes' }], 'Yes')).toBe('same');
    // Yes -> No -> Yes: newest-first history [No, Yes], current Yes, net same.
    expect(classifyNetChange([{ vote: 'No' }, { vote: 'Yes' }], 'Yes')).toBe('same');
    // No -> Abstain -> Yes: newest-first [Abstain, No], current Yes, net changed.
    expect(classifyNetChange([{ vote: 'Abstain' }, { vote: 'No' }], 'Yes')).toBe('changed');
  });
});

describe('buildActionVoteChanges', () => {
  const currents = new Map([
    ['drep_a', { role: 'DRep', vote: 'Yes', voted_power: 100 }],
    ['drep_b', { role: 'DRep', vote: 'Yes', voted_power: 50 }],
    ['drep_c', { role: 'DRep', vote: 'Abstain', voted_power: 10 }],
    ['pool_x', { role: 'SPO', vote: 'No', voted_power: 7 }],
  ]);

  it('splits changed from same-position re-votes and sums moved power', () => {
    const history = new Map([
      ['drep_a', h('DRep', ['No'])],
      ['drep_b', h('DRep', ['Yes'])],
      ['drep_c', h('DRep', ['Yes'])],
      ['pool_x', h('SPO', ['Yes'])],
    ]);
    const c = buildActionVoteChanges(history, currents, 'DRep');
    expect(c.changed).toBe(2);
    expect(c.samePosition).toBe(1);
    expect(c.toYes).toBe(1);
    expect(c.toAbstain).toBe(1);
    expect(c.toNo).toBe(0);
    expect(c.movedPower).toBe(110n);
    expect(c.unclassified).toBe(0);
  });

  it('classifies the SPO role separately', () => {
    const history = new Map([
      ['drep_a', h('DRep', ['No'])],
      ['pool_x', h('SPO', ['Yes'])],
    ]);
    const c = buildActionVoteChanges(history, currents, 'SPO');
    expect(c.changed).toBe(1);
    expect(c.toNo).toBe(1);
  });

  it('nulls movedPower when any changed voter lacks a power reading', () => {
    const cur = new Map([
      ['drep_a', { role: 'DRep', vote: 'Yes', voted_power: null }],
      ['drep_b', { role: 'DRep', vote: 'Yes', voted_power: 50 }],
    ]);
    const history = new Map([
      ['drep_a', h('DRep', ['No'])],
      ['drep_b', h('DRep', ['No'])],
    ]);
    const c = buildActionVoteChanges(history, cur, 'DRep');
    expect(c.changed).toBe(2);
    expect(c.movedPower).toBeNull();
  });

  it('counts history without a live current vote as unclassified', () => {
    const history = new Map([['drep_gone', h('DRep', ['No'])]]);
    const c = buildActionVoteChanges(history, currents, 'DRep');
    expect(c.changed).toBe(0);
    expect(c.unclassified).toBe(1);
  });
});

describe('describeActionVoteChanges', () => {
  it('renders directions and the power clause', () => {
    const s = describeActionVoteChanges({
      changed: 3, samePosition: 1, toYes: 2, toNo: 1, toAbstain: 0,
      movedPower: 343_700_000_000_000n, unclassified: 0,
    });
    expect(s).toBe('Changed votes: 2 to yes, 1 to no, together holding 343.7M ₳ of voting power.');
  });

  it('omits the power clause without a complete power reading', () => {
    const s = describeActionVoteChanges({
      changed: 1, samePosition: 0, toYes: 0, toNo: 0, toAbstain: 1,
      movedPower: null, unclassified: 0,
    });
    expect(s).toBe('Changed votes: 1 to abstain.');
  });

  it('returns null when nothing changed', () => {
    const s = describeActionVoteChanges({
      changed: 0, samePosition: 2, toYes: 0, toNo: 0, toAbstain: 0,
      movedPower: null, unclassified: 0,
    });
    expect(s).toBeNull();
  });
});

describe('buildVoteChangeView', () => {
  const row = (gaId: string, firstVote: string, currentVote: string): VoteChangeRow => ({
    gaId,
    title: `T ${gaId}`,
    topicSlug: `slug-${gaId}`,
    type: 'InfoAction',
    decidedEpoch: 600,
    firstVote,
    currentVote,
  });

  it('aggregates actions, directions and the top list', () => {
    const rows = [
      row('a', 'No', 'Yes'),
      row('a', 'Yes', 'Yes'),
      row('b', 'Yes', 'No'),
      row('b', 'Abstain', 'No'),
      row('c', 'Yes', 'Yes'),
    ];
    const v = buildVoteChangeView(rows, { decidedSwept: 10, decidedUnswept: 2, orphanPairs: 1 });
    expect(v.decidedSwept).toBe(10);
    expect(v.actionsWithChange).toBe(2);
    expect(v.changedCount).toBe(3);
    expect(v.samePositionCount).toBe(2);
    expect(v.toYes).toBe(1);
    expect(v.toNo).toBe(2);
    expect(v.toAbstain).toBe(0);
    expect(v.topActions).toHaveLength(2);
    expect(v.topActions[0].gaId).toBe('b');
    expect(v.topActions[0].changedCount).toBe(2);
    expect(v.topActions[0].href).toBe('/t/slug-b/');
    expect(v.decidedUnswept).toBe(2);
    expect(v.orphanPairs).toBe(1);
  });

  it('caps the top list at five and drops zero-change actions', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((id, i) =>
      Array.from({ length: i + 1 }, () => row(id, 'No', 'Yes')),
    );
    const v = buildVoteChangeView(rows, { decidedSwept: 6, decidedUnswept: 0, orphanPairs: 0 });
    expect(v.topActions).toHaveLength(5);
    expect(v.topActions[0].gaId).toBe('f');
    expect(v.topActions.map((t) => t.changedCount)).toEqual([6, 5, 4, 3, 2]);
  });

  it('handles an empty network without inventing zeros', () => {
    const v = buildVoteChangeView([], { decidedSwept: 0, decidedUnswept: 0, orphanPairs: 0 });
    expect(v.actionsWithChange).toBe(0);
    expect(v.topActions).toEqual([]);
  });
});
