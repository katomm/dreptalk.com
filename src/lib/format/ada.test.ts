import { describe, expect, it } from 'vitest';
import { formatAda, formatAdaCompact, lovelaceToAdaDecimal } from './ada.js';

describe('formatAda', () => {
  it('formats lovelace as whole ADA with the ₳ symbol and thousands separators', () => {
    expect(formatAda('100000000000')).toBe('100,000 ₳');
    expect(formatAda('5000000000')).toBe('5,000 ₳');
    expect(formatAda(0)).toBe('0 ₳');
  });

  it('rounds sub-ADA remainders away', () => {
    expect(formatAda('39558962833000')).toBe('39,558,963 ₳');
  });

  it('returns null for absent or non-numeric input', () => {
    expect(formatAda(null)).toBeNull();
    expect(formatAda(undefined)).toBeNull();
    expect(formatAda('')).toBeNull();
    expect(formatAda('abc')).toBeNull();
  });
});

describe('formatAdaCompact', () => {
  it('abbreviates large amounts to K/M/B with the ₳ symbol', () => {
    expect(formatAdaCompact('39558962833000')).toBe('39.6M ₳');
    expect(formatAdaCompact('12400000000000')).toBe('12.4M ₳');
    expect(formatAdaCompact('950000000000')).toBe('950K ₳');
    expect(formatAdaCompact(0)).toBe('0 ₳');
  });

  it('honours a custom fraction-digit count for billions', () => {
    expect(formatAdaCompact('3210000000000000', 2)).toBe('3.21B ₳');
    expect(formatAdaCompact('6660000000000000', 2)).toBe('6.66B ₳');
  });

  it('returns null for absent or non-numeric input', () => {
    expect(formatAdaCompact(null)).toBeNull();
    expect(formatAdaCompact('abc')).toBeNull();
  });
});

describe('lovelaceToAdaDecimal', () => {
  it('formats lovelace as an exact ADA decimal string, trailing zeros trimmed', () => {
    expect(lovelaceToAdaDecimal(39558963000000n)).toBe('39558963');
    expect(lovelaceToAdaDecimal(1234567n)).toBe('1.234567');
    expect(lovelaceToAdaDecimal(1200000n)).toBe('1.2');
    expect(lovelaceToAdaDecimal(1n)).toBe('0.000001');
    expect(lovelaceToAdaDecimal(0n)).toBe('0');
  });

  it('keeps full precision past Number.MAX_SAFE_INTEGER, unlike the Number/1e6 shortcut', () => {
    // 2^53 + 1 lovelace: the last digit is unrepresentable as a JS double.
    const lovelace = 9_007_199_254_740_993n;
    expect(lovelaceToAdaDecimal(lovelace)).toBe('9007199254.740993');
    // The exact bug this replaces: the float path rounds the final lovelace away.
    expect((Number(lovelace) / 1e6).toString()).not.toBe('9007199254.740993');
  });

  it('handles negative amounts', () => {
    expect(lovelaceToAdaDecimal(-1234567n)).toBe('-1.234567');
  });
});
