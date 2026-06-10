import { describe, it, expect } from 'vitest';
import { parseSnippet, cleanMarkdownSnippet } from './snippet.js';

describe('parseSnippet', () => {
  it('splits marker-wrapped matches into match segments', () => {
    expect(parseSnippet('raise the \x01treasury\x02 cap')).toEqual([
      { text: 'raise the ', match: false },
      { text: 'treasury', match: true },
      { text: ' cap', match: false },
    ]);
  });

  it('handles multiple matches and markers at the edges', () => {
    expect(parseSnippet('\x01net\x02 \x01change\x02')).toEqual([
      { text: 'net', match: true },
      { text: ' ', match: false },
      { text: 'change', match: true },
    ]);
  });

  it('treats HTML as inert text', () => {
    expect(parseSnippet('<script>alert(1)</script>')).toEqual([
      { text: '<script>alert(1)</script>', match: false },
    ]);
  });

  it('returns no match segments for marker-free text', () => {
    expect(parseSnippet('plain text').some((s) => s.match)).toBe(false);
  });
});

describe('cleanMarkdownSnippet', () => {
  it('strips leading markdown noise and emphasis markers', () => {
    expect(cleanMarkdownSnippet('## **Bold** start')).toBe('Bold start');
    expect(cleanMarkdownSnippet('> quoted `code` here')).toBe('quoted code here');
  });

  it('does not eat match markers', () => {
    expect(cleanMarkdownSnippet('# \x01treasury\x02 cap')).toBe('\x01treasury\x02 cap');
  });

  it('preserves a leading hyphen that is part of a word', () => {
    expect(cleanMarkdownSnippet('-based reform')).toBe('-based reform');
  });

  it('strips a markdown list marker followed by whitespace', () => {
    expect(cleanMarkdownSnippet('- list item')).toBe('list item');
  });
});

describe('parseSnippet (edge cases)', () => {
  it('treats an unclosed open marker as match to end of string', () => {
    expect(parseSnippet('tail \x01unclosed')).toEqual([
      { text: 'tail ', match: false },
      { text: 'unclosed', match: true },
    ]);
  });
});
