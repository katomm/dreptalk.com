/// <reference types="@cloudflare/workers-types" />
// Mention extraction (marked token walk) and slug resolution tests.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { extractMentionSlugs, resolveMentions, MAX_MENTIONS_PER_POST } from './mentions.js';

const db = () => env.DB;

describe('extractMentionSlugs', () => {
  it('finds mentions at start, after whitespace, and in parentheses', () => {
    expect(extractMentionSlugs('@alice-drep hi')).toEqual(['alice-drep']);
    expect(extractMentionSlugs('cc (@bob) and\n@carol too')).toEqual(['bob', 'carol']);
  });

  it('dedupes and ignores emails, code spans and code fences', () => {
    expect(extractMentionSlugs('@a1 again @a1')).toEqual(['a1']);
    expect(extractMentionSlugs('mail me at foo@bar.com')).toEqual([]);
    expect(extractMentionSlugs('use `@alice` in code')).toEqual([]);
    expect(extractMentionSlugs('```\n@alice\n```')).toEqual([]);
  });

  it('ignores uppercase and too-short candidates and caps the count', () => {
    expect(extractMentionSlugs('@Alice @x')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `@slug-${i}`).join(' ');
    expect(extractMentionSlugs(many).length).toBe(MAX_MENTIONS_PER_POST);
  });
});

describe('resolveMentions', () => {
  it('resolves DRep and pool slugs to hrefs and linked user ids', async () => {
    await db()
      .prepare(
        `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug)
         VALUES ('drep1abc', 'registered', 1, 0, 0, 'alice-drep')`,
      )
      .run();
    // pools has no other NOT NULL columns beyond pool_id (image_fetch_attempts
    // has a DEFAULT 0), so the minimum insert is just the id plus the slug.
    await db()
      .prepare(`INSERT INTO pools (pool_id, slug) VALUES ('pool1xyz', 'bobs-pool')`)
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
      userId: 'user-alice',
    });
    expect(map.get('bobs-pool')).toEqual({
      slug: 'bobs-pool',
      href: '/spos/bobs-pool/',
      userId: null,
    });
    expect(map.has('nobody')).toBe(false);
  });

  it('resolves a slug with no linked user to userId null', async () => {
    await db()
      .prepare(
        `INSERT INTO dreps (drep_id, status, active, last_synced_at, created_at, slug)
         VALUES ('drep2def', 'registered', 1, 0, 0, 'lonely')`,
      )
      .run();
    const map = await resolveMentions(db(), ['lonely']);
    expect(map.get('lonely')?.userId).toBeNull();
  });
});
