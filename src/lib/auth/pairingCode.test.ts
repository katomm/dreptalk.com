import { describe, it, expect } from 'vitest';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  generatePairingCode,
  formatPairingCode,
  normalizePairingCode,
} from './pairingCode.js';

describe('pairing code alphabet', () => {
  it('excludes every common confusable', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(ch);
    }
  });
});

describe('generatePairingCode', () => {
  it('produces codes of the expected length using only alphabet characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
  });

  it('does not return the same code twice in a small sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generatePairingCode());
    expect(seen.size).toBe(200);
  });
});

describe('formatPairingCode', () => {
  it('splits into two groups of four', () => {
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('normalizePairingCode', () => {
  it('upper-cases and strips spaces and hyphens', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode('  ABCD EFGH ')).toBe('ABCDEFGH');
  });

  it('rejects wrong lengths', () => {
    expect(normalizePairingCode('ABCDEFG')).toBeNull();
    expect(normalizePairingCode('ABCDEFGHI')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
  });

  it('rejects characters outside the alphabet, including confusables', () => {
    expect(normalizePairingCode('ABCDEFG0')).toBeNull();
    expect(normalizePairingCode('ABCDEFGO')).toBeNull();
    expect(normalizePairingCode('ABCDEFG1')).toBeNull();
  });

  it('does not remap ambiguous characters onto alphabet members', () => {
    // A remapping implementation would turn the trailing O into 0 or Q and
    // succeed; correct behaviour is a clean rejection.
    expect(normalizePairingCode('23456789'.slice(0, 7) + 'O')).toBeNull();
  });

  it('accepts a freshly generated code round-trip', () => {
    const code = generatePairingCode();
    expect(normalizePairingCode(formatPairingCode(code))).toBe(code);
  });
});
