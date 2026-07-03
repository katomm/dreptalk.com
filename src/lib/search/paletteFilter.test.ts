import { describe, it, expect } from 'vitest';
import { filterRowsByScope } from './paletteFilter.js';

const rows = [
  { group: 'Governance Actions' },
  { group: 'Discussions' },
  { group: 'DReps' },
  { group: 'Help' },
  { group: 'Pages' },
  { group: 'Exact match' },
];

describe('filterRowsByScope', () => {
  it('all keeps everything', () => {
    expect(filterRowsByScope(rows, 'all')).toHaveLength(6);
  });
  it('forum keeps discussions only', () => {
    expect(filterRowsByScope(rows, 'forum').map((r) => r.group)).toEqual(['Discussions']);
  });
  it('governance keeps governance actions only', () => {
    expect(filterRowsByScope(rows, 'governance').map((r) => r.group)).toEqual(['Governance Actions']);
  });
  it('dreps keeps dreps only', () => {
    expect(filterRowsByScope(rows, 'dreps').map((r) => r.group)).toEqual(['DReps']);
  });
  it('help keeps help only', () => {
    expect(filterRowsByScope(rows, 'help').map((r) => r.group)).toEqual(['Help']);
  });
});
