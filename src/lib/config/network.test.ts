import { describe, it, expect } from 'vitest';
import { resolveNetwork } from './network';

describe('resolveNetwork', () => {
  it('defaults to mainnet when the value is undefined', () => {
    const cfg = resolveNetwork(undefined);
    expect(cfg.network).toBe('mainnet');
    expect(cfg.koiosBaseUrl).toBe('https://api.koios.rest/api/v1');
    expect(cfg.networkId).toBe(1);
    expect(cfg.stakePrefix).toBe('stake');
  });

  it('defaults to mainnet when the value is an empty string', () => {
    expect(resolveNetwork('').network).toBe('mainnet');
  });

  it('returns preprod config when the value is preprod', () => {
    const cfg = resolveNetwork('preprod');
    expect(cfg.network).toBe('preprod');
    expect(cfg.koiosBaseUrl).toBe('https://preprod.koios.rest/api/v1');
    expect(cfg.networkId).toBe(0);
    expect(cfg.stakePrefix).toBe('stake_test');
    expect(cfg.addrPrefix).toBe('addr_test');
  });

  it('accepts an explicit mainnet value', () => {
    expect(resolveNetwork('mainnet').network).toBe('mainnet');
  });

  it('throws on an unknown explicit value', () => {
    expect(() => resolveNetwork('testnet')).toThrow(/invalid CARDANO_NETWORK/i);
  });
});
