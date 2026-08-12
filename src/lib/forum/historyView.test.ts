import { describe, it, expect } from 'vitest';
import { clampVersionPair, formatVersionTime, statText, versionLabel } from './historyView.js';

describe('clampVersionPair', () => {
  it('defaults to the previous version against the current one', () => {
    expect(clampVersionPair(null, null, 3)).toEqual({ from: 1, to: 0 });
  });

  it('returns null when there is nothing to compare', () => {
    expect(clampVersionPair(null, null, 1)).toBeNull();
    expect(clampVersionPair(null, null, 0)).toBeNull();
  });

  it('keeps a valid pair', () => {
    expect(clampVersionPair('3', '1', 4)).toEqual({ from: 3, to: 1 });
  });

  it('never lets to reach the oldest version', () => {
    // to = 2 in a 3-version history would leave no older baseline.
    expect(clampVersionPair(null, '2', 3)).toEqual({ from: 2, to: 1 });
  });

  it('clamps instead of inverting when from is not older than to', () => {
    expect(clampVersionPair('0', '2', 4)).toEqual({ from: 3, to: 2 });
    expect(clampVersionPair('1', '1', 4)).toEqual({ from: 2, to: 1 });
  });

  it('ignores junk input', () => {
    expect(clampVersionPair('abc', '-4', 3)).toEqual({ from: 1, to: 0 });
    expect(clampVersionPair('99', '99', 3)).toEqual({ from: 2, to: 1 });
  });
});

describe('versionLabel', () => {
  it('names the current version Current', () => {
    expect(versionLabel(0, 3, true)).toBe('Current');
  });

  it('numbers older versions oldest-first', () => {
    expect(versionLabel(1, 3, false)).toBe('Version 2');
    expect(versionLabel(2, 3, false)).toBe('Version 1');
  });
});

describe('statText', () => {
  it('reports word counts', () => {
    expect(statText(12, 4, true)).toBe('+12 / -4');
  });

  it('reports a formatting-only change rather than a zero count', () => {
    expect(statText(0, 0, true)).toBe('formatting only');
  });

  it('reports no change when nothing differs', () => {
    expect(statText(0, 0, false)).toBe('no change');
  });
});

describe('formatVersionTime', () => {
  it('formats identically regardless of the host locale', () => {
    expect(formatVersionTime(Date.UTC(2026, 7, 12, 14, 31))).toMatch(/12 Aug 2026/);
  });
});
