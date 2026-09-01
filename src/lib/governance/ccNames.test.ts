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

describe('curated committee names', () => {
  const phil = '13493790d9b03483a1e1e684ea4faf1ee48a58f402574e7f2246f4d4';

  it('fills the gap for a credential without a self-declared name, by cold and by hot key', () => {
    const hotToCold = new Map([['68bb0b4276021f82364056aa9f4d38ba5ac59b26c166cbeaa9408746', phil]]);
    const index = buildCcNameIndex([], hotToCold);
    expect(index.byCold(phil)).toBe('Phil_uplc');
    expect(index.byCold(phil.toUpperCase())).toBe('Phil_uplc');
    expect(index.byHot('68bb0b4276021f82364056aa9f4d38ba5ac59b26c166cbeaa9408746')).toBe('Phil_uplc');
    expect(index.byCold('0000000000000000000000000000000000000000000000000000000000')).toBeNull();
  });

  it('keeps a self-declared on-chain name ahead of the curated table', () => {
    const hot = '68bb0b4276021f82364056aa9f4d38ba5ac59b26c166cbeaa9408746';
    const hotToCold = new Map([[hot, phil]]);
    const index = buildCcNameIndex([{ hotKeyHex: hot, name: 'Declared Name', sourceBlockTime: 1 } as never], hotToCold);
    expect(index.byCold(phil)).toBe('Declared Name');
    expect(index.byHot(hot)).toBe('Declared Name');
  });
});
