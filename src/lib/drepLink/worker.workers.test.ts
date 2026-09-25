import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleRequest } from './worker.js';
import { resolveNetwork } from '../config/network.js';
import { upsertDrep } from '../db/dreps.js';
import { drepArgs, insertHandle } from './__fixtures__/drepHandles.js';

const NOW = 1_800_000_000;
const cfg = resolveNetwork(null);
const A = 'drep1yftc8zs7gjcj4a9nxzplz4wg6cwweya0kxp8adnw59vsyrqvrysud';
const go = (path: string, init?: RequestInit, cache: Cache | null = null) =>
  handleRequest(new Request(`https://drep.link${path}`, init), { db: env.DB, cfg, now: NOW, cache });

function fakeCache() {
  const store = new Map<string, Response>();
  const cache = {
    async match(k: Request) {
      return store.get(k.url)?.clone();
    },
    async put(k: Request, r: Response) {
      store.set(k.url, r.clone());
    },
  } as unknown as Cache;
  return { cache, store };
}

describe('handleRequest', () => {
  it('302s a live handle straight to the slug profile path', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'P'));
    await env.DB.prepare('UPDATE dreps SET slug = ? WHERE drep_id = ?').bind('p-rysud', A).run();
    await insertHandle(env.DB, 'p', A);
    const res = await go('/P/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://dreptalk.com/dreps/p-rysud/');
    // Handles change rarely (90-day cooldown), so a hit may be kept for an hour.
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });
  it('falls back to the id path when the DRep has no slug', async () => {
    await upsertDrep(env.DB, drepArgs(A, null));
    await insertHandle(env.DB, 'p', A);
    expect((await go('/p')).headers.get('location')).toBe(`https://dreptalk.com/dreps/${A}/`);
  });
  it('sends an unknown handle to the DRep search, cached only briefly', async () => {
    const res = await go('/nobody-here');
    expect(res.headers.get('location')).toBe('https://dreptalk.com/search/?q=nobody-here&scope=dreps');
    // A freshly claimed handle must not stay hidden behind a cached miss for long.
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });
  it('sends an expired handle to search', async () => {
    await insertHandle(env.DB, 'old', A, { releasedAt: NOW - 1 });
    expect((await go('/old')).headers.get('location')).toContain('/search/?q=old');
  });
  it('redirects a DRep id', async () => {
    expect((await go(`/${A}`)).headers.get('location')).toBe(`https://dreptalk.com/dreps/${A}/`);
  });
  it('serves the landing page, robots.txt, HEAD, and 405 for POST', async () => {
    const landing = await go('/');
    expect(landing.status).toBe(200);
    expect(landing.headers.get('content-type')).toContain('text/html');
    expect(await (await go('/robots.txt')).text()).toContain('Allow: /');
    expect((await go('/p', { method: 'HEAD' })).status).toBe(302);
    expect((await go('/p', { method: 'POST' })).status).toBe(405);
  });
  it('caches the landing page and answers HEAD without a body', async () => {
    const { cache, store } = fakeCache();
    await go('/', undefined, cache);
    expect(store.has('https://drep.link/')).toBe(true);
    const head = await go('/', { method: 'HEAD' }, cache);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
  it('answers a handle from the cache without touching D1', async () => {
    const { cache } = fakeCache();
    await upsertDrep(env.DB, drepArgs(A, 'P'));
    await insertHandle(env.DB, 'p', A);
    await go('/p', undefined, cache);
    await env.DB.prepare('DELETE FROM drep_handles').run();
    expect((await go('/P/', undefined, cache)).headers.get('location')).toBe(`https://dreptalk.com/dreps/${A}/`);
  });
});
