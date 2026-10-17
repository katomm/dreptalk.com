import { describe, it, expect } from 'vitest';
import { withdrawalLovelace } from './pack';

const payload = (amounts: unknown[]) =>
  JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [amounts.map((a) => [{}, a]), null] });

describe('withdrawalLovelace', () => {
  it('sums number and string amounts, a string above 2^53 digit for digit', () => {
    expect(withdrawalLovelace(payload([5_000_000, '9007199254740993']))).toBe(9_007_199_259_740_993n);
  });

  it('is null when any amount is unreadable, or for another action type', () => {
    expect(withdrawalLovelace(payload([5_000_000, 'abc']))).toBeNull();
    expect(withdrawalLovelace(JSON.stringify({ tag: 'InfoAction', contents: [] }))).toBeNull();
    expect(withdrawalLovelace(null)).toBeNull();
  });
});
