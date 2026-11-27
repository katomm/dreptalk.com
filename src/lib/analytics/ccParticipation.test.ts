import { describe, expect, it } from 'vitest';
import { consideredCcActions } from './ccParticipation.js';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CcVoteRow, DecidedCcAction } from '../db/committee.js';

const members: CommitteeMemberTerm[] = [
  { coldKeyHex: 'cold1', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
  { coldKeyHex: 'cold2', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
];
const hotToCold = new Map([
  ['hot1', 'cold1'],
  ['hot2', 'cold2'],
]);

const action = (over: Partial<DecidedCcAction>): DecidedCcAction => ({
  gaId: 'ga1', title: 'T', topicSlug: null, type: 'InfoAction', status: 'closed', decidedEpoch: 600, ratifiedEpoch: null, expiryEpoch: null,
  submittedAt: 0, ccYesPct: 100, thresholdsJson: '{"cc":66.7,"ccBelowMinSize":false,"v":2}',
  ...over,
});
const vote = (hot: string, v: 'Yes' | 'No' | 'Abstain', blockTime: number | null): CcVoteRow => ({
  voterId: hot, hotKeyHex: hot, vote: v, blockTime, metaUrl: null,
});

const run = (actions: DecidedCcAction[], votesByAction = new Map<string, CcVoteRow[]>()) =>
  consideredCcActions({ actions, votesByAction, members, hotToCold, currentEpoch: 650 });

describe('consideredCcActions', () => {
  it('skips actions with an empty active set and counts them', () => {
    const { considered, skipped } = run([action({ gaId: 'ga1' }), action({ gaId: 'ga2', decidedEpoch: 400 })]);
    expect(considered.length).toBe(1);
    expect(skipped).toBe(1);
  });

  it('skips actions whose boundary is null', () => {
    // An enacted action with no decided epoch and no ratified epoch has no boundary.
    const unplaced = action({ gaId: 'ga2', status: 'enacted', decidedEpoch: null as unknown as number });
    const { considered, skipped } = run([action({ gaId: 'ga1' }), unplaced]);
    expect(considered.map((c) => c.action.gaId)).toEqual(['ga1']);
    expect(skipped).toBe(1);
  });

  it('drops non-eligible types before considering', () => {
    const { considered, skipped } = run([action({ gaId: 'ga1', type: 'NoConfidence' })]);
    expect(considered).toEqual([]);
    expect(skipped).toBe(0);
  });

  it('keeps a vote cast inside the boundary epoch, no cutoff', () => {
    const late = 10_000 * 86_400;
    const { considered } = run([action({ gaId: 'ga1' })], new Map([['ga1', [vote('hot1', 'Yes', late)]]]));
    expect(considered[0].finalByCold.get('cold1')?.blockTime).toBe(late);
  });

  it('sorts by decided epoch, then gaId', () => {
    const { considered } = run([
      action({ gaId: 'gb', decidedEpoch: 610 }),
      action({ gaId: 'gz', decidedEpoch: 600 }),
      action({ gaId: 'ga', decidedEpoch: 610 }),
    ]);
    expect(considered.map((c) => c.action.gaId)).toEqual(['gz', 'ga', 'gb']);
  });

  it('keeps the latest of two hot-key votes per member', () => {
    const hot = new Map([...hotToCold, ['hot1b', 'cold1']]);
    const { considered } = consideredCcActions({
      actions: [action({ gaId: 'ga1' })],
      votesByAction: new Map([['ga1', [vote('hot1', 'No', 1), vote('hot1b', 'Yes', 2)]]]),
      members,
      hotToCold: hot,
      currentEpoch: 650,
    });
    expect(considered[0].finalByCold.get('cold1')?.vote).toBe('Yes');
  });
});
