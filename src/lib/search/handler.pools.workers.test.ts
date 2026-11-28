/// <reference types="@cloudflare/workers-types" />
// The SPO scope against a real D1: ticker and name matching, ranking, totals
// and facet counts, the pool id fast path, and the on-chain notice for a
// pasted pool id that has no row because the pool never voted.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';
import { encodeBech32 } from '../crypto/bech32.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

const poolId = (n: number) => encodeBech32('pool', new Uint8Array(28).fill(n));

async function seedPool(o: { id: string; ticker: string | null; name: string | null; slug?: string | null }) {
  await db()
    .prepare('INSERT INTO pools (pool_id, ticker, name, slug, synced_at) VALUES (?, ?, ?, ?, ?)')
    .bind(o.id, o.ticker, o.name, o.slug ?? null, NOW)
    .run();
}

async function seedVote(ga: string, voter: string) {
  await db()
    .prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES (?, 'SPO', ?, 'Yes', ?, ?)`)
    .bind(ga, voter, NOW, NOW)
    .run();
}

describe('handleSearch spos scope', () => {
  it('matches ticker or name, exact ticker first, with a total and vote counts', async () => {
    await seedPool({ id: poolId(1), ticker: 'XWINGB', name: 'Some other pool', slug: 'xwingb-aaaa' });
    await seedPool({ id: poolId(2), ticker: 'XWING', name: 'Xwing Stake', slug: 'xwing-bbbb' });
    await seedPool({ id: poolId(3), ticker: 'ZZZ', name: 'The xwing collective' });
    await seedVote('ga-1#0', poolId(1));
    await seedVote('ga-2#0', poolId(1));

    const res = await handleSearch(db(), 'xwing', { scope: 'spos', counts: true });
    expect(res.spos.map((p) => p.ticker)).toEqual(['XWING', 'XWINGB', 'ZZZ']);
    expect(res.total).toBe(3);
    expect(res.counts?.spos).toBe(3);
    expect(res.spos[1]).toMatchObject({ href: '/spos/xwingb-aaaa/', votes: 2 });
    expect(res.spos[2].href).toBe(`/spos/${poolId(3)}/`);
  });

  it('treats % and _ in the query as literal characters', async () => {
    await seedPool({ id: poolId(4), ticker: 'PCT', name: '100% uptime pool' });
    await seedPool({ id: poolId(5), ticker: 'PCX', name: '100 uptime pool' });
    const res = await handleSearch(db(), '100%', { scope: 'spos' });
    expect(res.spos.map((p) => p.ticker)).toEqual(['PCT']);
  });

  it('includes pools in the palette groups and the page-mode counts', async () => {
    await seedPool({ id: poolId(6), ticker: 'QUOKKA', name: 'Quokka pool' });
    const palette = await handleSearch(db(), 'quokka');
    expect(palette.spos.map((p) => p.ticker)).toEqual(['QUOKKA']);
    const page = await handleSearch(db(), 'quokka', { counts: true });
    expect(page.counts?.spos).toBe(1);
  });
});

describe('handleSearch pool id', () => {
  it('resolves a stored pool id to its profile without calling Koios', async () => {
    await seedPool({ id: poolId(10), ticker: 'KNOWN', name: 'Known pool', slug: 'known-cccc' });
    const lookupPool = vi.fn();
    const res = await handleSearch(db(), poolId(10), { lookupPool });
    expect(res.exact).toEqual({ kind: 'pool', href: '/spos/known-cccc/', label: 'Known pool' });
    expect(res.poolNotice).toBeNull();
    expect(lookupPool).not.toHaveBeenCalled();
  });

  it('shows the never-voted notice for a pool that exists on chain but has no row', async () => {
    const lookupPool = vi.fn().mockResolvedValue({ ticker: 'NOVOTE', name: 'Silent pool' });
    const res = await handleSearch(db(), poolId(11), { scope: 'spos', counts: true, lookupPool });
    expect(lookupPool).toHaveBeenCalledWith(poolId(11));
    expect(res.exact).toBeNull();
    expect(res.poolNotice).toEqual({ poolId: poolId(11), ticker: 'NOVOTE', name: 'Silent pool' });
  });

  it('shows no notice for an unknown pool or a failed lookup', async () => {
    const unknown = await handleSearch(db(), poolId(12), { lookupPool: vi.fn().mockResolvedValue(null) });
    expect(unknown.poolNotice).toBeNull();
    const failed = await handleSearch(db(), poolId(13), { lookupPool: vi.fn().mockRejectedValue(new Error('timeout')) });
    expect(failed.poolNotice).toBeNull();
  });

  it('never calls Koios for free text or an invalid pool id', async () => {
    const lookupPool = vi.fn();
    await handleSearch(db(), 'pool1notarealid', { lookupPool });
    await handleSearch(db(), 'some ticker', { lookupPool });
    expect(lookupPool).not.toHaveBeenCalled();
  });
});
