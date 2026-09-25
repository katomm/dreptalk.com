import { describe, it, expect } from 'vitest';
import {
  parseGovSort,
  parseGovStatus,
  trendingScore,
  trendingOrderKey,
  type GovActionTopic,
} from './sort.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

interface Over {
  id: string;
  status?: string;
  submittedEpoch?: number | null;
  submittedAt?: number | null;
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
      submittedAt: o.submittedAt ?? null,
      expiryEpoch: o.expiryEpoch ?? null,
      decidedEpoch: o.decidedEpoch ?? null,
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

describe('trendingOrderKey', () => {
  // The page orders by this stored key in the database, so it must induce the SAME
  // ordering as the live trendingScore(row, now), for ANY now. That is the whole point:
  // the now-dependent recency factor is common to every row and cancels, so the key
  // needs no clock and can be precomputed once by the cron.
  const sample: GovActionTopic[] = [
    row({ id: 'whale', status: 'active', votes: 2000, postCount: 1, lastPostAt: NOW - 40 * DAY }),
    row({ id: 'fresh', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 2 * DAY }),
    row({ id: 'hot', status: 'active', votes: 50, postCount: 5, lastPostAt: NOW - 5 * DAY }),
    row({ id: 'enacted', status: 'enacted', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY }),
    row({ id: 'old-quiet', status: 'active', votes: 0, postCount: 1, lastPostAt: NOW - 20 * DAY }),
  ];

  const byKeyDesc = (rows: GovActionTopic[]) =>
    [...rows].sort((a, b) => trendingOrderKey(b) - trendingOrderKey(a)).map((r) => r.topic.id);
  const byScoreDesc = (rows: GovActionTopic[], now: number) =>
    [...rows].sort((a, b) => trendingScore(b, now) - trendingScore(a, now)).map((r) => r.topic.id);

  it('induces the same order as trendingScore, independent of now', () => {
    const keyOrder = byKeyDesc(sample);
    expect(keyOrder).toEqual(byScoreDesc(sample, NOW));
    // The clock only ever moves forward past every row's last activity (last_post_at is
    // a past submission epoch or a past reply time), so render later: the key order is
    // unchanged and still matches the live score order. (now < last_post_at is
    // non-physical and outside the documented contract, so it is not asserted.)
    expect(byScoreDesc(sample, NOW + 7 * DAY)).toEqual(keyOrder);
    expect(byScoreDesc(sample, NOW + 365 * DAY)).toEqual(keyOrder);
  });

  it('applies the terminal penalty as an additive log2(TERMINAL_PENALTY) shift', () => {
    const active = row({ id: 'a', status: 'active', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY });
    const enacted = row({ id: 'e', status: 'enacted', votes: 10, postCount: 3, lastPostAt: NOW - 3 * DAY });
    // In log space the *0.15 recency multiplier becomes +log2(0.15).
    expect(trendingOrderKey(enacted)).toBeCloseTo(trendingOrderKey(active) + Math.log2(0.15), 10);
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
