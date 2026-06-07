import { describe, it, expect } from 'vitest';
import { parseGovSort, sortGovActionTopics, trendingScore, type GovActionTopic } from './sort.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

interface Over {
  id: string;
  status?: string;
  submittedEpoch?: number | null;
  expiryEpoch?: number | null;
  decidedEpoch?: number | null;
  postCount?: number;
  lastPostAt?: number;
  votes?: number;
}

function row(o: Over): GovActionTopic {
  return {
    topic: { id: o.id, post_count: o.postCount ?? 1, last_post_at: o.lastPostAt ?? NOW } as never,
    action: {
      status: o.status ?? 'active',
      submittedEpoch: o.submittedEpoch ?? null,
      expiryEpoch: o.expiryEpoch ?? null,
      decidedEpoch: o.decidedEpoch ?? null,
      drepYes: o.votes ?? null,
      drepNo: null, drepAbstain: null, spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
    } as never,
  };
}

const ids = (rows: GovActionTopic[]) => rows.map((r) => r.topic.id);

describe('parseGovSort', () => {
  it('defaults to trending and passes valid modes through', () => {
    expect(parseGovSort(null)).toBe('trending');
    expect(parseGovSort('garbage')).toBe('trending');
    expect(parseGovSort('closing')).toBe('closing');
    expect(parseGovSort('ratified')).toBe('ratified');
    expect(parseGovSort('new')).toBe('new');
  });
});

describe('sortGovActionTopics', () => {
  it('new: newest submission first, includes every status', () => {
    const rows = [
      row({ id: 'old', submittedEpoch: 300, status: 'enacted' }),
      row({ id: 'newest', submittedEpoch: 320, status: 'active' }),
      row({ id: 'mid', submittedEpoch: 310, status: 'expired' }),
    ];
    expect(ids(sortGovActionTopics(rows, 'new', NOW))).toEqual(['newest', 'mid', 'old']);
  });

  it('closing: only active with an expiry, soonest first', () => {
    const rows = [
      row({ id: 'far', status: 'active', expiryEpoch: 400 }),
      row({ id: 'soon', status: 'active', expiryEpoch: 360 }),
      row({ id: 'no-expiry', status: 'active', expiryEpoch: null }),
      row({ id: 'enacted', status: 'enacted', expiryEpoch: 350 }),
    ];
    expect(ids(sortGovActionTopics(rows, 'closing', NOW))).toEqual(['soon', 'far']);
  });

  it('ratified: only ratified/enacted, most recently decided first', () => {
    const rows = [
      row({ id: 'active', status: 'active' }),
      row({ id: 'older', status: 'enacted', decidedEpoch: 500 }),
      row({ id: 'recent', status: 'ratified', decidedEpoch: 520 }),
    ];
    expect(ids(sortGovActionTopics(rows, 'ratified', NOW))).toEqual(['recent', 'older']);
  });

  it('trending: only active, recent + engaged ranks above stale', () => {
    const rows = [
      row({ id: 'stale-busy', status: 'active', postCount: 50, lastPostAt: NOW - 30 * DAY }),
      row({ id: 'fresh-busy', status: 'active', postCount: 20, votes: 10, lastPostAt: NOW - 1000 }),
      row({ id: 'enacted', status: 'enacted', postCount: 99, lastPostAt: NOW }),
    ];
    const out = ids(sortGovActionTopics(rows, 'trending', NOW));
    expect(out).not.toContain('enacted'); // not active
    expect(out[0]).toBe('fresh-busy'); // recency lifts it above the stale-but-busy one
  });
});

describe('trendingScore', () => {
  it('ranks a recent action above an equally engaged older one', () => {
    const recent = row({ id: 'r', postCount: 5, votes: 3, lastPostAt: NOW - 1000 });
    const old = row({ id: 'o', postCount: 5, votes: 3, lastPostAt: NOW - 20 * DAY });
    expect(trendingScore(recent, NOW)).toBeGreaterThan(trendingScore(old, NOW));
  });
});
