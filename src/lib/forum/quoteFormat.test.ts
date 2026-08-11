import { describe, it, expect } from 'vitest';
import { escapeMarkdownLinkLabel, escapeQuotedText, buildQuoteBlock, appendQuote } from './quoteFormat.js';

describe('escapeMarkdownLinkLabel', () => {
  it('escapes backslash and square brackets', () => {
    expect(escapeMarkdownLinkLabel('a[b]c')).toBe('a\\[b\\]c');
    expect(escapeMarkdownLinkLabel('back\\slash')).toBe('back\\\\slash');
  });
  it('collapses newlines to spaces and trims', () => {
    expect(escapeMarkdownLinkLabel('  line1\nline2  ')).toBe('line1 line2');
  });
});

describe('escapeQuotedText', () => {
  it('escapes backslash and square brackets so a link cannot form', () => {
    expect(escapeQuotedText('[label](http://evil.example)')).toBe('\\[label\\](http://evil.example)');
    expect(escapeQuotedText('a\\b')).toBe('a\\\\b');
  });
  it('escapes "<" so raw HTML tags and angle autolinks cannot form', () => {
    expect(escapeQuotedText('<a href="http://evil.example">cardano.org</a>')).toBe(
      '\\<a href="http://evil.example">cardano.org\\</a>',
    );
    expect(escapeQuotedText('<http://evil.example>')).toBe('\\<http://evil.example>');
  });
  it('leaves plain prose and its newlines untouched', () => {
    expect(escapeQuotedText('Article 5 (2) applies')).toBe('Article 5 (2) applies');
    expect(escapeQuotedText('one\ntwo')).toBe('one\ntwo');
  });
});

describe('buildQuoteBlock', () => {
  it('builds a linked attribution header and prefixed quote with a trailing blank line', () => {
    const out = buildQuoteBlock({ author: 'Lucas', href: '/t/x?tab=discussion#post-9', text: 'hello\nworld' });
    expect(out).toBe('[Lucas](/t/x?tab=discussion#post-9) wrote:\n\n> hello\n> world\n\n');
  });
  it('renders blank source lines as a bare ">"', () => {
    const out = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: 'a\n\nb' });
    expect(out).toBe('[A](/t/x#post-1) wrote:\n\n> a\n>\n> b\n\n');
  });
  it('adds a quote level to lines that are already quoted (no toggle)', () => {
    const out = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: '> nested' });
    expect(out).toBe('[A](/t/x#post-1) wrote:\n\n> > nested\n\n');
  });
  it('escapes link syntax in the quoted text so it cannot become a link', () => {
    const out = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: '[cardano.org](http://evil.example)' });
    expect(out).toBe('[A](/t/x#post-1) wrote:\n\n> \\[cardano.org\\](http://evil.example)\n\n');
  });
});

describe('appendQuote', () => {
  it('returns the block unchanged when the draft is empty', () => {
    const block = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: 'q' });
    expect(appendQuote('', block, 20000)).toEqual({ ok: true, value: block });
  });
  it('inserts a blank line between existing non-empty draft and the block', () => {
    const block = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: 'q' });
    const r = appendQuote('draft text', block, 20000);
    expect(r).toEqual({ ok: true, value: `draft text\n\n${block}` });
  });
  it('does not double the separator when the draft already ends with a blank line', () => {
    const block = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: 'q' });
    const r = appendQuote('draft\n\n', block, 20000);
    expect(r).toEqual({ ok: true, value: `draft\n\n${block}` });
  });
  it('stacks a second quote below the first, preserving the first', () => {
    const b1 = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: 'one' });
    const b2 = buildQuoteBlock({ author: 'B', href: '/t/x#post-2', text: 'two' });
    const first = appendQuote('', b1, 20000);
    if (!first.ok) throw new Error('unexpected');
    const second = appendQuote(first.value, b2, 20000);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.startsWith(b1)).toBe(true);
      expect(second.value.endsWith(b2)).toBe(true);
    }
  });
  it('rejects when the result would exceed maxLength', () => {
    const block = buildQuoteBlock({ author: 'A', href: '/t/x#post-1', text: 'x'.repeat(50) });
    expect(appendQuote('', block, 10)).toEqual({ ok: false, reason: 'length' });
  });
});
