import { describe, it, expect } from 'vitest';
import {
  isReportable,
  parseDelegationDigestPayload,
  formatDelegationDigestDetail,
  formatDelegationDigestHeadline,
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
    expect(isReportable({ votes: 1 })).toBe(true);
  });
  it('stays silent for a DRep that did not vote', () => {
    expect(isReportable({ votes: 0 })).toBe(false);
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
  it('leads with what the DRep did and when', () => {
    expect(formatDelegationDigestHeadline(base)).toBe('Your DRep voted on 3 actions in epoch 612');
    expect(formatDelegationDigestHeadline({ ...base, votes: 1, titles: ['A'] })).toBe(
      'Your DRep voted on 1 action in epoch 612',
    );
  });
  it('names older zero-vote rows plainly', () => {
    const none = { ...base, votes: 0, withRationale: 0, titles: [], openUnvoted: 2 };
    expect(formatDelegationDigestHeadline(none)).toBe('Your DRep cast no votes in epoch 612');
    expect(formatDelegationDigestDetail(none)).toBe('');
    expect(formatDelegationDigestInboxTitle(none)).toBe('Your DRep cast no votes in epoch 612');
  });
  it('lists the titles, then the rationale count', () => {
    expect(formatDelegationDigestDetail(base)).toBe(
      'Treasury withdrawal for X, Info action Y, Hard fork Z. 2 with a rationale',
    );
    expect(formatDelegationDigestDetail({ ...base, withRationale: 0, titles: [] })).toBe('None with a rationale');
  });
  it('never mentions open actions, even from older rows', () => {
    expect(formatDelegationDigestInboxTitle(base)).not.toMatch(/open/);
  });
  it('lists titles and the rest as a count', () => {
    expect(formatDelegationDigestTitles(base)).toBe('Treasury withdrawal for X, Info action Y, Hard fork Z');
    expect(formatDelegationDigestTitles({ ...base, votes: 5 })).toBe(
      'Treasury withdrawal for X, Info action Y, Hard fork Z and 2 more',
    );
    expect(formatDelegationDigestTitles({ ...base, titles: [] })).toBeNull();
  });
  it('joins headline and detail in the inbox row', () => {
    expect(formatDelegationDigestInboxTitle(base)).toBe(
      'Your DRep voted on 3 actions in epoch 612: Treasury withdrawal for X, Info action Y, Hard fork Z. 2 with a rationale',
    );
  });
});
