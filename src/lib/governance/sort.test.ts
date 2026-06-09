import { describe, it, expect } from 'vitest';
import {
  parseGovSort,
  sortGovActionTopics,
  trendingScore,
  type GovActionTopic,
} from './sort.js';

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

  it('closing: open actions only, soonest expiry first, nulls last (excludes terminal)', () => {
    const rows = [
      row({ id: 'far', status: 'active', expiryEpoch: 400 }),
      row({ id: 'soon', status: 'active', expiryEpoch: 360 }),
      row({ id: 'no-expiry', status: 'pending', expiryEpoch: null }),
      row({ id: 'enacted', status: 'enacted', expiryEpoch: 350 }),
      row({ id: 'expired', status: 'expired', expiryEpoch: 355 }),
      row({ id: 'closed', status: 'closed', expiryEpoch: 358 }),
    ];
    // terminal rows (enacted/expired/closed) are dropped even though their expiry is
    // soonest; the open ones order by expiry asc, the null-expiry one last.
    expect(ids(sortGovActionTopics(rows, 'closing', NOW))).toEqual(['soon', 'far', 'no-expiry']);
  });

  it('ratified: most recently decided first, nulls last, all statuses included', () => {
    const rows = [
      row({ id: 'active', status: 'active' }),
      row({ id: 'older', status: 'enacted', decidedEpoch: 500 }),
      row({ id: 'recent', status: 'ratified', decidedEpoch: 520 }),
    ];
    // recent(520) > older(500) > active(null, pushed to end)
    expect(ids(sortGovActionTopics(rows, 'ratified', NOW))).toEqual(['recent', 'older', 'active']);
  });

  it('trending: fresh+engaged ranks above stale, all statuses included', () => {
    const rows = [
      row({ id: 'stale-busy', status: 'active', postCount: 50, lastPostAt: NOW - 30 * DAY }),
      row({ id: 'fresh-busy', status: 'active', postCount: 20, votes: 10, lastPostAt: NOW - 1000 }),
      row({ id: 'enacted', status: 'enacted', postCount: 1, lastPostAt: NOW - 60 * DAY }),
    ];
    const out = ids(sortGovActionTopics(rows, 'trending', NOW));
    expect(out).toContain('enacted'); // pure ordering: all rows present
    expect(out.indexOf('fresh-busy')).toBeLessThan(out.indexOf('stale-busy')); // recency lifts it
  });

  it('trending: hot discussion > fresh submission > old vote-heavy action', () => {
    const rows = [
      row({ id: 'whale', status: 'active', votes: 2000, postCount: 1, lastPostAt: NOW - 40 * DAY }),
      row({ id: 'fresh', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 2 * DAY }),
      row({ id: 'hot', status: 'active', votes: 50, postCount: 5, lastPostAt: NOW - 5 * DAY }),
    ];
    expect(ids(sortGovActionTopics(rows, 'trending', NOW))).toEqual(['hot', 'fresh', 'whale']);
  });

  it('trending: actions with no comments fall back to post-date (last_post_at) order', () => {
    const rows = [
      row({ id: 'older', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 20 * DAY }),
      row({ id: 'newer', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 5 * DAY }),
    ];
    expect(ids(sortGovActionTopics(rows, 'trending', NOW))).toEqual(['newer', 'older']);
  });

  it('trending: equal scores break ties by newest submission epoch', () => {
    const rows = [
      row({ id: 'a', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 5 * DAY, submittedEpoch: 300 }),
      row({ id: 'b', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 5 * DAY, submittedEpoch: 320 }),
    ];
    expect(ids(sortGovActionTopics(rows, 'trending', NOW))).toEqual(['b', 'a']);
  });
});

describe('trendingScore', () => {
  it('ranks a recent action above an equally engaged older one', () => {
    const recent = row({ id: 'r', postCount: 5, votes: 3, lastPostAt: NOW - 1000 });
    const old = row({ id: 'o', postCount: 5, votes: 3, lastPostAt: NOW - 20 * DAY });
    expect(trendingScore(recent, NOW)).toBeGreaterThan(trendingScore(old, NOW));
  });

  it('penalises a terminal action below an otherwise identical active one', () => {
    const active = row({ id: 'active', status: 'active', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY });
    const enacted = row({ id: 'enacted', status: 'enacted', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY });
    expect(trendingScore(enacted, NOW)).toBeLessThan(trendingScore(active, NOW));
    expect(trendingScore(enacted, NOW)).toBeCloseTo(trendingScore(active, NOW) * 0.15, 8);
  });

  it('log-damps vote totals so an old vote-heavy action loses to a fresh submission', () => {
    const whale = row({ id: 'whale', status: 'active', votes: 2000, postCount: 1, lastPostAt: NOW - 40 * DAY });
    const fresh = row({ id: 'fresh', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 2 * DAY });
    expect(trendingScore(fresh, NOW)).toBeGreaterThan(trendingScore(whale, NOW));
  });
});
