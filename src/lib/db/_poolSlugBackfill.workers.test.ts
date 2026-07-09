import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillPoolSlugs } from './pools.js';

// backfillPoolSlugs assigns a slug (ticker/name base + id tail) to every pool
// that lacks one, writing them in a single atomic batch. Guards the batch path
// (a per-row loop would blow the Worker subrequest limit on a full backfill).
describe('backfillPoolSlugs', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM pools');
  });

  it('slugs pools with a ticker/name, skips the un-sluggable, and never rewrites an existing slug', async () => {
    await env.DB.prepare("INSERT INTO pools (pool_id, ticker, name) VALUES ('pool1a', 'HEPHY', 'Hephaestus')").run();
    await env.DB.prepare("INSERT INTO pools (pool_id, ticker, name, slug) VALUES ('pool1b', 'DONE', 'Done', 'done-fixed')").run();
    await env.DB.prepare("INSERT INTO pools (pool_id, ticker, name) VALUES ('pool1c', NULL, NULL)").run();

    const res = await backfillPoolSlugs(env.DB);
    expect(res.missing).toBe(1);
    expect(res.assigned).toBe(1);

    const rows = (await env.DB.prepare('SELECT pool_id, slug FROM pools ORDER BY pool_id').all<{ pool_id: string; slug: string | null }>()).results;
    const slugById = new Map(rows.map((r) => [r.pool_id, r.slug]));
    expect(slugById.get('pool1a')).toMatch(/^hephy-/); // assigned from the ticker
    expect(slugById.get('pool1b')).toBe('done-fixed'); // pre-existing slug untouched
    expect(slugById.get('pool1c')).toBeNull(); // no ticker or name, stays unslugged
  });

  it('assigns many pools in one call (the batch path)', async () => {
    for (let i = 0; i < 120; i++) {
      await env.DB.prepare("INSERT INTO pools (pool_id, ticker) VALUES (?, ?)").bind(`pool1x${i}`, `TICK${i}`).run();
    }
    const res = await backfillPoolSlugs(env.DB);
    expect(res.assigned).toBe(120);
    const n = (await env.DB.prepare('SELECT count(*) AS n FROM pools WHERE slug IS NOT NULL').first<{ n: number }>())?.n;
    expect(n).toBe(120);
  });
});
