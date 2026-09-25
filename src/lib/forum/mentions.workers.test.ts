/// <reference types="@cloudflare/workers-types" />
// Mention slug resolution tests against D1. Extraction lives in mentions.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveMentions } from './mentions.js';

const db = () => env.DB;

describe('resolveMentions', () => {
  it('resolves DRep and pool slugs to hrefs and linked user ids', async () => {
    await db()
      .prepare(
        `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug, name)
         VALUES ('drep1abc', 'registered', 1, 0, 0, 'alice-drep', 'Alice')`,
      )
      .run();
    // pools has no other NOT NULL columns beyond pool_id (image_fetch_attempts
    // has a DEFAULT 0), so the minimum insert is just the id plus the slug.
    // No name: the label falls back to the ticker.
    await db()
      .prepare(`INSERT INTO pools (pool_id, slug, ticker) VALUES ('pool1xyz', 'bobs-pool', 'BOBS')`)
      .run();
    await db()
      .prepare(
        `INSERT INTO users (id, drep_id, created_at, last_verified_at)
         VALUES ('user-alice', 'drep1abc', 0, 0)`,
      )
      .run();

    const map = await resolveMentions(db(), ['alice-drep', 'bobs-pool', 'nobody']);
    expect(map.get('alice-drep')).toEqual({
      slug: 'alice-drep',
      href: '/dreps/alice-drep/',
      label: 'Alice',
      userId: 'user-alice',
    });
    expect(map.get('bobs-pool')).toEqual({
      slug: 'bobs-pool',
      href: '/spos/bobs-pool/',
      label: 'BOBS',
      userId: null,
    });
    expect(map.has('nobody')).toBe(false);
  });

  it('resolves a slug with no linked user to userId null, label falls back to the slug', async () => {
    await db()
      .prepare(
        `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug)
         VALUES ('drep2def', 'registered', 1, 0, 0, 'lonely')`,
      )
      .run();
    const map = await resolveMentions(db(), ['lonely']);
    expect(map.get('lonely')?.userId).toBeNull();
    expect(map.get('lonely')?.label).toBe('lonely');
  });
});
