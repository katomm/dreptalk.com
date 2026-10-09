// Unit tests for the compact ada labels of the impact charts.
import { describe, it, expect } from 'vitest';
import { adaCompact } from './chart.js';

describe('adaCompact', () => {
  it('drops trailing zeros of billions and millions alike', () => {
    expect(adaCompact(1.5e9)).toBe('1.5B ₳');
    expect(adaCompact(2e9)).toBe('2B ₳');
    expect(adaCompact(1.25e9)).toBe('1.25B ₳');
    expect(adaCompact(1e6)).toBe('1M ₳');
    expect(adaCompact(64.9e6)).toBe('64.9M ₳');
  });

  it('keeps whole ada below a million untouched', () => {
    expect(adaCompact(100)).toBe('100 ₳');
    expect(adaCompact(250_000)).toBe('250,000 ₳');
  });
});
