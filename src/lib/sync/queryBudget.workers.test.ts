/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { countingDb, allowance } from './queryBudget.js';

describe('countingDb', () => {
  it('counts first/all/run/raw on bound and unbound statements', async () => {
    const { db, meter } = countingDb(env.DB);
    await db.prepare('SELECT 1').first();
    await db.prepare('SELECT ?').bind(1).all();
    await db.prepare('SELECT 1').raw();
    await db.prepare("CREATE TABLE IF NOT EXISTS qb_t (x INTEGER)").run();
    expect(meter.used()).toBe(4);
  });

  it('counts a batch by its statement count and the batch still executes', async () => {
    const { db, meter } = countingDb(env.DB);
    await db.prepare('CREATE TABLE IF NOT EXISTS qb_b (x INTEGER)').run();
    const before = meter.used();
    await db.batch([
      db.prepare('INSERT INTO qb_b (x) VALUES (?)').bind(1),
      db.prepare('INSERT INTO qb_b (x) VALUES (?)').bind(2),
      db.prepare('INSERT INTO qb_b (x) VALUES (?)').bind(3),
    ]);
    expect(meter.used() - before).toBe(3);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM qb_b').first<{ n: number }>();
    expect(row!.n).toBe(3);
  });

  it('counts a failing query', async () => {
    const { db, meter } = countingDb(env.DB);
    await expect(db.prepare('SELECT * FROM no_such_table').all()).rejects.toThrow();
    expect(meter.used()).toBe(1);
  });
});

describe('allowance', () => {
  it('measures only what was spent since it was created', async () => {
    const { db, meter } = countingDb(env.DB);
    await db.prepare('SELECT 1').first();
    const a = allowance(meter, 3);
    expect(a.remaining()).toBe(3);
    await db.prepare('SELECT 1').first();
    expect(a.spent()).toBe(1);
    expect(a.covers(2)).toBe(true);
    expect(a.covers(3)).toBe(false);
  });
});
