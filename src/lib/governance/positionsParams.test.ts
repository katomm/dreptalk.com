import { describe, it, expect } from 'vitest';
import { parsePositionsRole, parseVoterSort } from './positionsParams.js';

describe('parseVoterSort', () => {
  it('accepts the known sorts', () => {
    expect(parseVoterSort('power')).toBe('power');
    expect(parseVoterSort('recent')).toBe('recent');
  });

  it('falls back to newest first for a missing or unknown value', () => {
    expect(parseVoterSort(null)).toBe('recent');
    expect(parseVoterSort(undefined)).toBe('recent');
    expect(parseVoterSort('')).toBe('recent');
    expect(parseVoterSort('foo')).toBe('recent');
    expect(parseVoterSort('POWER')).toBe('recent');
  });
});

describe('parsePositionsRole', () => {
  it('accepts spo and cc and defaults to the DRep list', () => {
    expect(parsePositionsRole('spo')).toBe('spo');
    expect(parsePositionsRole('cc')).toBe('cc');
    expect(parsePositionsRole('drep')).toBe('drep');
    expect(parsePositionsRole(null)).toBe('drep');
    expect(parsePositionsRole('SPO')).toBe('drep');
  });
});
