/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getProvenanceCache, isFreshProvenanceCache, putProvenanceCache } from './provenanceCache.js';

const db = () => env.DB as D1Database;

describe('provenance_cache (migration 0082)', () => {
  it('returns null on a cache miss', async () => {
    expect(await getProvenanceCache(db(), 'drep1miss', 12)).toBeNull();
  });

  it('round-trips a payload and upserts on the same key', async () => {
    await putProvenanceCache(db(), 'drep1a', 12, '{"v":1}', 1000);
    expect(await getProvenanceCache(db(), 'drep1a', 12)).toEqual({ computedAt: 1000, payload: '{"v":1}' });
    await putProvenanceCache(db(), 'drep1a', 12, '{"v":2}', 2000);
    expect(await getProvenanceCache(db(), 'drep1a', 12)).toEqual({ computedAt: 2000, payload: '{"v":2}' });
  });

  it('keeps windows for the same drep separate', async () => {
    await putProvenanceCache(db(), 'drep1b', 12, '{"w":12}', 1000);
    await putProvenanceCache(db(), 'drep1b', 36, '{"w":36}', 1000);
    expect((await getProvenanceCache(db(), 'drep1b', 12))?.payload).toBe('{"w":12}');
    expect((await getProvenanceCache(db(), 'drep1b', 36))?.payload).toBe('{"w":36}');
  });

  it('freshness: inside the 3h TTL is fresh, at or beyond is stale', () => {
    expect(isFreshProvenanceCache(1000, 1000 + 3 * 3600_000 - 1)).toBe(true);
    expect(isFreshProvenanceCache(1000, 1000 + 3 * 3600_000)).toBe(false);
  });
});
