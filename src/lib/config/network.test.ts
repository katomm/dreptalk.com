import { describe, it, expect } from 'vitest';
import { resolveNetwork, txExplorerUrl, governanceActionUrl } from './network';

describe('explorer links (neutral cardano-foundation landing)', () => {
  it('links a governance action with no network param on mainnet', () => {
    expect(governanceActionUrl('mainnet', 'gov_action1abc')).toBe(
      'https://explorer.cardano.org/governance-action?id=gov_action1abc',
    );
  });

  it('adds the network param for preprod', () => {
    expect(governanceActionUrl('preprod', 'gov_action1abc')).toBe(
      'https://explorer.cardano.org/governance-action?id=gov_action1abc&network=preprod',
    );
  });

  it('links a transaction through the same landing', () => {
    expect(txExplorerUrl('mainnet', 'deadbeef')).toBe(
      'https://explorer.cardano.org/transaction?id=deadbeef',
    );
    expect(txExplorerUrl('preprod', 'deadbeef')).toBe(
      'https://explorer.cardano.org/transaction?id=deadbeef&network=preprod',
    );
  });
});

describe('resolveNetwork', () => {
  it('defaults to mainnet when the value is undefined', () => {
    const cfg = resolveNetwork(undefined);
    expect(cfg.network).toBe('mainnet');
    expect(cfg.koiosBaseUrl).toBe('https://api.koios.rest/api/v1');
    expect(cfg.networkId).toBe(1);
    expect(cfg.stakePrefix).toBe('stake');
    expect(cfg.addrPrefix).toBe('addr');
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
