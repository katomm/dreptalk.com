import { describe, it, expect } from 'vitest';
import { GOV_ACTION_TYPES, parseGovType } from './types.js';

describe('GOV_ACTION_TYPES', () => {
  it('lists the seven canonical Koios proposal types in display order', () => {
    expect(GOV_ACTION_TYPES.map((t) => t.value)).toEqual([
      'InfoAction',
      'TreasuryWithdrawals',
      'ParameterChange',
      'HardForkInitiation',
      'NewConstitution',
      'NewCommittee',
      'NoConfidence',
    ]);
  });

  it('gives every type a non-empty label', () => {
    for (const t of GOV_ACTION_TYPES) expect(t.label.length).toBeGreaterThan(0);
  });
});

describe('parseGovType', () => {
  it('passes through a known type', () => {
    expect(parseGovType('TreasuryWithdrawals')).toBe('TreasuryWithdrawals');
    expect(parseGovType('InfoAction')).toBe('InfoAction');
  });

  it('returns null for unknown, empty, or null input', () => {
    expect(parseGovType('bogus')).toBeNull();
    expect(parseGovType('')).toBeNull();
    expect(parseGovType(null)).toBeNull();
  });
});
