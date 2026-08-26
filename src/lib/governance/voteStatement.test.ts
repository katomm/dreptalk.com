import { describe, it, expect } from 'vitest';
import {
  MIN_INDEXABLE_RATIONALE_CHARS, voteStatementPath, positionsVoterAnchor, isVoteStatementIndexable, voteDisplay,
} from './voteStatement.js';

describe('voteStatementPath', () => {
  it('builds role-scoped paths', () => {
    expect(voteStatementPath('drep', 'ada-1', 'fund-x')).toBe('/dreps/ada-1/vote/fund-x/');
    expect(voteStatementPath('spo', 'pool-1', 'fund-x')).toBe('/spos/pool-1/vote/fund-x/');
  });
});
describe('positionsVoterAnchor', () => {
  it('carries the voter both as resolvable param and as scroll anchor', () => {
    expect(positionsVoterAnchor('drep1abc')).toBe('?tab=positions&voter=drep1abc#voter-drep1abc');
    expect(positionsVoterAnchor('pool1abc', 'spo')).toBe('?tab=positions&role=spo&voter=pool1abc#voter-pool1abc');
  });
  it('omits voter= for the unpaginated CC list', () => {
    expect(positionsVoterAnchor('cc1abc', 'cc')).toBe('?tab=positions&role=cc#voter-cc1abc');
  });
});
describe('isVoteStatementIndexable', () => {
  it('needs metadata and a long-enough rationale', () => {
    const long = 'x'.repeat(MIN_INDEXABLE_RATIONALE_CHARS);
    expect(isVoteStatementIndexable({ hasMetadata: true, rationaleText: long })).toBe(true);
    expect(isVoteStatementIndexable({ hasMetadata: false, rationaleText: long })).toBe(false);
    expect(isVoteStatementIndexable({ hasMetadata: true, rationaleText: 'short' })).toBe(false);
  });
});
describe('voteDisplay', () => {
  it('maps the three known votes', () => {
    expect(voteDisplay('Yes')).toEqual({ label: 'VOTED YES', tone: 'yes' });
    expect(voteDisplay('No')).toEqual({ label: 'VOTED NO', tone: 'no' });
    expect(voteDisplay('Abstain')).toEqual({ label: 'ABSTAINED', tone: 'abstain' });
  });
  it('does not treat an unknown value as abstain', () => {
    expect(voteDisplay('Weird')).toEqual({ label: 'VOTED', tone: 'other' });
  });
  it('is case-insensitive (optimistic votes are stored lowercase)', () => {
    expect(voteDisplay('yes')).toEqual({ label: 'VOTED YES', tone: 'yes' });
    expect(voteDisplay('no')).toEqual({ label: 'VOTED NO', tone: 'no' });
    expect(voteDisplay('abstain')).toEqual({ label: 'ABSTAINED', tone: 'abstain' });
  });
});
