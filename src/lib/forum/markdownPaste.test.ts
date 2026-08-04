import { describe, it, expect } from 'vitest';
import { linkFromPaste } from './markdownPaste.js';

function show(state: { text: string; start: number; end: number }): string {
  const { text, start } = state;
  return `${text.slice(0, start)}|${text.slice(start)}`;
}

describe('linkFromPaste', () => {
  it('wraps the selection as a link and drops the caret after it', () => {
    const out = linkFromPaste({ text: 'see docs here', start: 4, end: 8 }, 'https://example.com');
    expect(out!.text).toBe('see [docs](https://example.com) here');
    expect(show(out!)).toBe('see [docs](https://example.com)| here');
  });

  it('accepts http URLs', () => {
    const out = linkFromPaste({ text: 'docs', start: 0, end: 4 }, 'http://a.test/x');
    expect(out!.text).toBe('[docs](http://a.test/x)');
  });

  it('trims surrounding whitespace on the pasted URL', () => {
    const out = linkFromPaste({ text: 'docs', start: 0, end: 4 }, '  https://a.test  ');
    expect(out!.text).toBe('[docs](https://a.test)');
  });

  it('returns null with no selection', () => {
    expect(linkFromPaste({ text: 'docs', start: 2, end: 2 }, 'https://a.test')).toBeNull();
  });

  it('returns null when the clipboard is not a URL', () => {
    expect(linkFromPaste({ text: 'docs', start: 0, end: 4 }, 'just some text')).toBeNull();
  });

  it('returns null for a non-http scheme', () => {
    expect(linkFromPaste({ text: 'docs', start: 0, end: 4 }, 'ftp://a.test/x')).toBeNull();
  });

  it('returns null when the pasted text spans multiple lines', () => {
    expect(linkFromPaste({ text: 'docs', start: 0, end: 4 }, 'https://a.test\nmore')).toBeNull();
  });
});
