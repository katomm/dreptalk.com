/// <reference types="@cloudflare/workers-types" />
// Mention candidate listing tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listMentionCandidates } from './mentionCandidates.js';

const db = () => env.DB;

describe('listMentionCandidates', () => {
  it('lists dreps and pools with slugs, sorted by name, and skips slugless rows', async () => {
    await db().prepare(
      `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, name, slug)
       VALUES ('drep1a', 'registered', 1, 0, 0, 'Zoe', 'zoe'),
              ('drep1b', 'registered', 1, 0, 0, 'No Slug Drep', NULL)`,
    ).run();
    await db().prepare(
      `INSERT INTO pools (pool_id, ticker, name, slug)
       VALUES ('pool1a', 'APOOL', 'Alpha Pool', 'alpha-pool'),
              ('pool1b', 'NOSLG', 'No Slug Pool', NULL)`,
    ).run();

    const out = await listMentionCandidates(db());
    expect(out).toEqual([
      { slug: 'alpha-pool', name: 'Alpha Pool', kind: 'pool' },
      { slug: 'zoe', name: 'Zoe', kind: 'drep' },
    ]);
  });

  it('falls back to ticker then slug when a pool has no name', async () => {
    await db().prepare(
      `INSERT INTO pools (pool_id, ticker, name, slug) VALUES ('pool1c', 'TICK', NULL, 'ticky')`,
    ).run();
    const out = await listMentionCandidates(db());
    expect(out).toEqual([{ slug: 'ticky', name: 'TICK', kind: 'pool' }]);
  });
});
