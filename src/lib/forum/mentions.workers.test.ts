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

  it('matches at the start of an inline text segment, right after a bold/link/code span', () => {
    // marked splits inline content into a new text token at each inline element
    // boundary, so '@a1' right after '**foo**' starts its own segment and
    // matches the '^' branch, same as the tokenizer Task 5 shares this regex with.
    expect(extractMentionSlugs('**foo**@a1 x')).toEqual(['a1']);
  });

  it('still ignores an email address, which never starts a new text segment at @', () => {
    expect(extractMentionSlugs('foo@bar.com')).toEqual([]);
  });

  it('ignores a mid-word "@" not preceded by start / whitespace / "(" / ">"', () => {
    // Symmetry with markdown.ts's mention tokenizer: GFM's inline text
    // tokenizer halts before '@' to attempt an email autolink, so marked can
    // invoke that tokenizer at a mid-word position, but extraction must never
    // count it as a mention there.
    expect(extractMentionSlugs('foo@a1 x')).toEqual([]);
    expect(extractMentionSlugs('.@a1 x')).toEqual([]);
  });
});

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
