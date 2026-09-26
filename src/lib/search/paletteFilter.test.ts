import { describe, it, expect } from 'vitest';
import { filterRowsByScope, type RowScope } from './paletteFilter.js';

const rows: Array<{ scope: RowScope; label: string }> = [
  { scope: null, label: 'Stored DRep' },
  { scope: 'dreps', label: 'Some DRep' },
  { scope: 'governance', label: 'Some GA' },
  { scope: 'all', label: 'A page' },
];

describe('filterRowsByScope', () => {
  it('keeps the exact match under a non-matching pill', () => {
    const out = filterRowsByScope(rows, 'governance');
    expect(out.map((r) => r.label)).toEqual(['Stored DRep', 'Some GA']);
  });

  it('keeps everything under all', () => {
    expect(filterRowsByScope(rows, 'all')).toHaveLength(4);
  });

  it('keeps only the exact match plus the matching scope', () => {
    const out = filterRowsByScope(rows, 'dreps');
    expect(out.map((r) => r.label)).toEqual(['Stored DRep', 'Some DRep']);
  });
});
