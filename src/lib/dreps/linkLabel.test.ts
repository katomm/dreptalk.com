import { describe, it, expect } from 'vitest';
import { linkDisplayLabel, dedupeLinks } from './linkLabel.js';

describe('linkDisplayLabel', () => {
  it('uses the label when present', () => {
    expect(linkDisplayLabel({ label: 'My Site', uri: 'https://example.com/x' })).toBe('My Site');
  });
  it('falls back to the host when the label is empty', () => {
    expect(linkDisplayLabel({ label: '', uri: 'https://www.example.com/x' })).toBe('example.com');
  });
  it('falls back to the raw uri when it does not parse', () => {
    expect(linkDisplayLabel({ label: '', uri: 'not a url' })).toBe('not a url');
  });
});

describe('dedupeLinks', () => {
  it('drops later links with the same uri', () => {
    expect(
      dedupeLinks([
        { label: 'Youtube', uri: 'https://youtube.com/@a' },
        { label: 'X', uri: 'https://x.com/a' },
        { label: 'Youtube', uri: 'https://youtube.com/@a' },
      ]),
    ).toEqual([
      { label: 'Youtube', uri: 'https://youtube.com/@a' },
      { label: 'X', uri: 'https://x.com/a' },
    ]);
  });
  it('treats uris differing only by surrounding whitespace as duplicates', () => {
    expect(
      dedupeLinks([
        { label: '', uri: 'https://example.com' },
        { label: '', uri: ' https://example.com ' },
      ]),
    ).toHaveLength(1);
  });
  it('keeps the first occurrence but adopts a label from a later duplicate', () => {
    expect(
      dedupeLinks([
        { label: '', uri: 'https://example.com' },
        { label: 'My Site', uri: 'https://example.com' },
      ]),
    ).toEqual([{ label: 'My Site', uri: 'https://example.com' }]);
  });
  it('keeps distinct uris untouched', () => {
    const links = [
      { label: 'A', uri: 'https://a.example' },
      { label: 'B', uri: 'https://b.example' },
    ];
    expect(dedupeLinks(links)).toEqual(links);
  });
});
