import { describe, it, expect } from 'vitest';
import { namesFromAuthors, buildCcNameIndex } from './ccNames.js';

describe('namesFromAuthors', () => {
  it('reads top-level string names', () => {
    expect(namesFromAuthors({ authors: [{ name: 'Cardano Curia' }] })).toEqual(['Cardano Curia']);
  });
  it('unwraps the JSON-LD @value form', () => {
    expect(namesFromAuthors({ authors: [{ name: { '@value': 'Tingvard' } }] })).toEqual(['Tingvard']);
  });
  it('falls back to body.authors ONLY when top-level authors is absent (no merge)', () => {
    expect(namesFromAuthors({ body: { authors: [{ name: 'Emurgo' }] } })).toEqual(['Emurgo']);
    // Top-level present -> body.authors is ignored entirely.
    expect(namesFromAuthors({ authors: [{ name: 'Top' }], body: { authors: [{ name: 'Body' }] } })).toEqual(['Top']);
  });
  it('sanitizes control characters, caps length, trims, dedupes, preserves order', () => {
    expect(namesFromAuthors({ authors: [{ name: ' A ' }, { name: '' }, { name: 'A' }, { name: 'B' }] })).toEqual(['A', 'B']);
    expect(namesFromAuthors({ authors: [{ name: 'x'.repeat(200) }] })[0].length).toBeLessThanOrEqual(80);
  });
  it('returns [] with no authors', () => {
    expect(namesFromAuthors({ body: { comment: 'x' } })).toEqual([]);
  });
});

describe('CcNameIndex (current display name, no as-of)', () => {
  const rows = [
    { hotKeyHex: 'hotold', name: 'Org Old', sourceBlockTime: 100 },
    { hotKeyHex: 'hotnew', name: 'Org New', sourceBlockTime: 200 },
    { hotKeyHex: 'hotx', name: 'Other', sourceBlockTime: 150 },
  ];
  const hotToCold = new Map([['hotold', 'colda'], ['hotnew', 'colda'], ['hotx', 'coldb']]);
  const idx = buildCcNameIndex(rows, hotToCold);

  it('byHot resolves a hot key directly (case-insensitive)', () => {
    expect(idx.byHot('HOTOLD')).toBe('Org Old');
    expect(idx.byHot('missing')).toBeNull();
  });
  it('byCold picks the latest name across the cold key\'s hot keys (rotation)', () => {
    expect(idx.byCold('colda')).toBe('Org New');
    expect(idx.byCold('COLDA')).toBe('Org New');
  });
  it('byCold returns null for an unknown cold key', () => {
    expect(idx.byCold('coldz')).toBeNull();
  });
});
