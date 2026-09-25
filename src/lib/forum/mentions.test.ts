// Mention extraction tests (marked token walk). Resolution against D1 lives in
// mentions.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { extractMentionSlugs, MAX_MENTIONS_PER_POST } from './mentions.js';

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
