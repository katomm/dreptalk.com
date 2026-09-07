import { describe, it, expect } from 'vitest';
import { isMainnet, lovelaceToAda } from './units.js';
import { resolveNetwork } from '../config/network.js';

describe('isMainnet', () => {
  it('gates the review on mainnet only', () => {
    expect(isMainnet(resolveNetwork('mainnet'))).toBe(true);
    expect(isMainnet(resolveNetwork('preprod'))).toBe(false);
  });
});

describe('lovelaceToAda', () => {
  it('converts strings and numbers and passes null through', () => {
    expect(lovelaceToAda('120000000000000')).toBe(120000000);
    expect(lovelaceToAda(1_000_000)).toBe(1);
    expect(lovelaceToAda(null)).toBeNull();
    expect(lovelaceToAda('not a number')).toBeNull();
  });
});
