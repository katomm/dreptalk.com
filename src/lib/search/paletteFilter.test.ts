import { describe, it, expect } from 'vitest';
import { filterRowsByScope } from './paletteFilter.js';

const rows = [
  { group: 'Exact match', label: 'Stored DRep' },
  { group: 'DReps', label: 'Some DRep' },
  { group: 'Governance Actions', label: 'Some GA' },
];

describe('filterRowsByScope', () => {
  it('keeps the exact match under a non-matching pill', () => {
    const out = filterRowsByScope(rows, 'governance');
    expect(out.map((r) => r.group)).toEqual(['Exact match', 'Governance Actions']);
  });

  it('keeps everything under all', () => {
    expect(filterRowsByScope(rows, 'all')).toHaveLength(3);
  });

  it('keeps only the exact match plus the matching scope', () => {
    const out = filterRowsByScope(rows, 'dreps');
    expect(out.map((r) => r.group)).toEqual(['Exact match', 'DReps']);
  });
});
