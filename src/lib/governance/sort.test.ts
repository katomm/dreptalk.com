import { describe, it, expect } from 'vitest';
import {
  parseGovSort,
  parseGovStatus,
  trendingOrderKey,
  type GovActionTopic,
} from './sort.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

interface Over {
  id: string;
  status?: string;
  postCount?: number;
  lastPostAt?: number;
  votes?: number;
}

function row(o: Over): GovActionTopic {
  return {
    topic: { id: o.id, post_count: o.postCount ?? 1, last_post_at: o.lastPostAt ?? NOW } as never,
    action: {
      status: o.status ?? 'active',
      drepYes: o.votes ?? null,
      drepNo: null, drepAbstain: null, spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
    } as never,
  };
}

describe('parseGovSort', () => {
  it('defaults to new and passes valid modes through', () => {
    expect(parseGovSort(null)).toBe('new');
    expect(parseGovSort('garbage')).toBe('new');
    expect(parseGovSort('trending')).toBe('trending');
    expect(parseGovSort('closing')).toBe('closing');
    expect(parseGovSort('ratified')).toBe('ratified');
    expect(parseGovSort('new')).toBe('new');
  });
});

describe('trendingOrderKey', () => {
  // The page orders by this stored key in the database. It needs no clock: the
  // recency factor is common to every row at a given render and cancels.
  it('ranks a recent action above an equally engaged older one', () => {
    const recent = row({ id: 'r', postCount: 5, votes: 3, lastPostAt: NOW - 1000 });
    const old = row({ id: 'o', postCount: 5, votes: 3, lastPostAt: NOW - 20 * DAY });
    expect(trendingOrderKey(recent)).toBeGreaterThan(trendingOrderKey(old));
  });

  it('applies the terminal penalty as an additive log2(TERMINAL_PENALTY) shift', () => {
    const active = row({ id: 'a', status: 'active', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY });
    const enacted = row({ id: 'e', status: 'enacted', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY });
    // In log space the *0.15 recency multiplier becomes +log2(0.15).
    expect(trendingOrderKey(enacted)).toBeCloseTo(trendingOrderKey(active) + Math.log2(0.15), 10);
  });

  it('log-damps vote totals so an old vote-heavy action loses to a fresh submission', () => {
    const whale = row({ id: 'whale', status: 'active', votes: 2000, postCount: 1, lastPostAt: NOW - 40 * DAY });
    const fresh = row({ id: 'fresh', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 2 * DAY });
    expect(trendingOrderKey(fresh)).toBeGreaterThan(trendingOrderKey(whale));
  });

  it('is deterministic for equal inputs (so the cron only-changed write can use ===)', () => {
    const r1 = row({ id: 'x', status: 'active', votes: 5, postCount: 2, lastPostAt: NOW - 1234 });
    const r2 = row({ id: 'x', status: 'active', votes: 5, postCount: 2, lastPostAt: NOW - 1234 });
    expect(trendingOrderKey(r1)).toBe(trendingOrderKey(r2));
  });
});

describe('parseGovStatus', () => {
  it('passes valid statuses through and defaults everything else to all', () => {
    expect(parseGovStatus(null)).toBe('all');
    expect(parseGovStatus('garbage')).toBe('all');
    expect(parseGovStatus('all')).toBe('all');
    expect(parseGovStatus('open')).toBe('open');
    expect(parseGovStatus('decided')).toBe('decided');
  });
});
