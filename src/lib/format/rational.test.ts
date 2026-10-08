import { describe, it, expect } from 'vitest';
import {
  compareRational,
  equalRational,
  formatLovelaceExact,
  formatRationalDecimal,
  formatRationalPercent,
  parseDecimal,
  rationalFromNumber,
  reduce,
} from './rational.js';

const r = (n: bigint, d: bigint) => ({ n, d });

describe('reduce', () => {
  it('reduces and moves the sign to the numerator', () => {
    expect(reduce(r(35n, 100n))).toEqual(r(7n, 20n));
    expect(reduce(r(3n, -6n))).toEqual(r(-1n, 2n));
    expect(reduce(r(0n, 5n))).toEqual(r(0n, 1n));
  });
  it('refuses a zero denominator', () => {
    expect(() => reduce(r(1n, 0n))).toThrow();
  });
});

describe('compareRational', () => {
  it('compares by cross multiplication', () => {
    expect(compareRational(r(1n, 10n), r(10n, 100n))).toBe(0);
    expect(compareRational(r(99n, 1000n), r(1n, 10n))).toBe(-1);
    expect(compareRational(r(3001n, 10000n), r(3n, 10n))).toBe(1);
    expect(equalRational(r(7n, 20n), r(35n, 100n))).toBe(true);
  });
});

describe('parseDecimal', () => {
  it('parses plain decimals exactly', () => {
    expect(parseDecimal('0.35', 3)).toEqual({ ok: true, value: r(7n, 20n) });
    expect(parseDecimal('600', 0)).toEqual({ ok: true, value: r(600n, 1n) });
    expect(parseDecimal('.5', 2)).toEqual({ ok: true, value: r(1n, 2n) });
    expect(parseDecimal('170.000001', 6)).toEqual({ ok: true, value: r(170000001n, 1000000n) });
  });
  it('accepts surrounding spaces and a single comma as the decimal point', () => {
    expect(parseDecimal(' 600 ', 0)).toEqual({ ok: true, value: r(600n, 1n) });
    expect(parseDecimal('0,35', 3)).toEqual({ ok: true, value: r(7n, 20n) });
  });
  it('rejects anything that is not one plain number', () => {
    for (const input of ['', ' ', 'abc', '1 000', '1,000.5', '0.35%', '-1', '1e3', '1.2.3', '1,2,3', '.']) {
      expect(parseDecimal(input, 6)).toEqual({ ok: false, error: 'nan' });
    }
  });
  it('rejects more decimal places than allowed', () => {
    expect(parseDecimal('0.3501', 3)).toEqual({ ok: false, error: 'places' });
    expect(parseDecimal('600.5', 0)).toEqual({ ok: false, error: 'places' });
  });
});

describe('rationalFromNumber', () => {
  it('reads the shortest decimal form of a float', () => {
    expect(rationalFromNumber(0.3)).toEqual(r(3n, 10n));
    expect(rationalFromNumber(0.003)).toEqual(r(3n, 1000n));
    expect(rationalFromNumber(500)).toEqual(r(500n, 1n));
    expect(rationalFromNumber(3e-7)).toEqual(r(3n, 10000000n));
  });
  it('keeps a repeating float as the decimal it prints as', () => {
    expect(rationalFromNumber(1 / 3)).toEqual(reduce(r(3333333333333333n, 10000000000000000n)));
  });
  it('answers null for what is no finite number', () => {
    expect(rationalFromNumber(Number.NaN)).toBeNull();
    expect(rationalFromNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatting', () => {
  it('prints terminating decimals exactly', () => {
    expect(formatRationalDecimal(r(7n, 20n))).toBe('0.35');
    expect(formatRationalDecimal(r(1n, 1n))).toBe('1');
    expect(formatRationalDecimal(r(1n, 3n), 4)).toBe('≈0.3333');
  });
  it('prints percent without losing digits', () => {
    expect(formatRationalPercent(r(3n, 1000n))).toBe('0.3%');
    expect(formatRationalPercent(r(3001n, 1000000n))).toBe('0.3001%');
    expect(formatRationalPercent(r(1n, 4n))).toBe('25%');
  });
  it('prints lovelace as ada with every significant digit', () => {
    expect(formatLovelaceExact(170_000_000n)).toBe('170 ₳');
    expect(formatLovelaceExact(170_000_001n)).toBe('170.000001 ₳');
    expect(formatLovelaceExact(100_000_000_000n)).toBe('100,000 ₳');
    expect(formatLovelaceExact(500_000n)).toBe('0.5 ₳');
  });
});
