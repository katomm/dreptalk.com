import { describe, it, expect } from 'vitest';
import {
  isReportable,
  parseDelegationDigestPayload,
  formatDelegationDigestDetail,
  formatDelegationDigestSummary,
  formatDelegationDigestTitles,
  formatDelegationDigestInboxTitle,
  type DelegationDigestPayload,
} from './delegationDigest.js';

const base: DelegationDigestPayload = {
  epoch: 612,
  drepId: 'drep1abc',
  votes: 3,
  withRationale: 2,
  titles: ['Treasury withdrawal for X', 'Info action Y', 'Hard fork Z'],
  openUnvoted: 1,
};

describe('isReportable', () => {
  it('reports a DRep that voted', () => {
    expect(isReportable({ votes: 1, openUnvoted: 0 })).toBe(true);
  });
  it('reports a registered DRep with open actions left', () => {
    expect(isReportable({ votes: 0, openUnvoted: 2 })).toBe(true);
  });
  it('stays silent for a DRep with nothing to report', () => {
    expect(isReportable({ votes: 0, openUnvoted: 0 })).toBe(false);
    expect(isReportable({ votes: 0, openUnvoted: null })).toBe(false);
  });
});

describe('parseDelegationDigestPayload', () => {
  it('round-trips a valid payload', () => {
    expect(parseDelegationDigestPayload(JSON.stringify(base))).toEqual(base);
  });
  it('accepts openUnvoted null', () => {
    const p = { ...base, openUnvoted: null };
    expect(parseDelegationDigestPayload(JSON.stringify(p))).toEqual(p);
  });
  it('rejects malformed input without throwing', () => {
    expect(parseDelegationDigestPayload(null)).toBeNull();
    expect(parseDelegationDigestPayload('not json')).toBeNull();
    expect(parseDelegationDigestPayload(JSON.stringify({ ...base, votes: -1 }))).toBeNull();
    expect(parseDelegationDigestPayload(JSON.stringify({ ...base, withRationale: 4 }))).toBeNull();
    expect(parseDelegationDigestPayload(JSON.stringify({ ...base, titles: [1] }))).toBeNull();
    expect(parseDelegationDigestPayload(JSON.stringify({ ...base, drepId: '' }))).toBeNull();
    expect(parseDelegationDigestPayload(JSON.stringify({ ...base, openUnvoted: '1' }))).toBeNull();
  });
});

describe('copy', () => {
  it('names votes, rationales and open actions', () => {
    expect(formatDelegationDigestDetail(base)).toBe(
      'Voted on 3 actions, 2 with a rationale. 1 open action without a vote',
    );
  });
  it('handles singulars and the no-rationale case', () => {
    expect(formatDelegationDigestDetail({ ...base, votes: 1, withRationale: 0, openUnvoted: 0 })).toBe(
      'Voted on 1 action, none with a rationale',
    );
  });
  it('says so when there were no votes', () => {
    expect(formatDelegationDigestDetail({ ...base, votes: 0, withRationale: 0, titles: [], openUnvoted: 2 })).toBe(
      'No votes. 2 open actions without a vote',
    );
  });
  it('leaves the open part out for a DRep that is not registered', () => {
    expect(formatDelegationDigestDetail({ ...base, openUnvoted: null })).toBe(
      'Voted on 3 actions, 2 with a rationale',
    );
  });
  it('prefixes the epoch in the summary', () => {
    expect(formatDelegationDigestSummary(base)).toBe(
      'Epoch 612: voted on 3 actions, 2 with a rationale. 1 open action without a vote',
    );
  });
  it('lists titles and the rest as a count', () => {
    expect(formatDelegationDigestTitles(base)).toBe('Treasury withdrawal for X, Info action Y, Hard fork Z');
    expect(formatDelegationDigestTitles({ ...base, votes: 5 })).toBe(
      'Treasury withdrawal for X, Info action Y, Hard fork Z and 2 more',
    );
    expect(formatDelegationDigestTitles({ ...base, titles: [] })).toBeNull();
  });
  it('appends the titles to the inbox row', () => {
    expect(formatDelegationDigestInboxTitle(base)).toBe(
      'Epoch 612: voted on 3 actions, 2 with a rationale. 1 open action without a vote. Actions: Treasury withdrawal for X, Info action Y, Hard fork Z',
    );
    expect(formatDelegationDigestInboxTitle({ ...base, titles: [] })).toBe(
      'Epoch 612: voted on 3 actions, 2 with a rationale. 1 open action without a vote',
    );
  });
});
