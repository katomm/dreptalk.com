import { describe, it, expect } from 'vitest';
import {
  resolveNetwork,
  txExplorerUrl,
  governanceActionUrl,
  epochStartUnix,
  epochFromUnix,
  epochStartMs,
  currentEpochProgress,
} from './network';

describe('explorer links (neutral cardano-foundation landing)', () => {
  it('links a governance action with no network param on mainnet', () => {
    // Path form: the switcher crashes on the ?id= query form for governance actions.
    expect(governanceActionUrl('mainnet', 'gov_action1abc')).toBe(
      'https://explorer.cardano.org/governance-action/gov_action1abc',
    );
  });

  it('adds the network param for preprod', () => {
    expect(governanceActionUrl('preprod', 'gov_action1abc')).toBe(
      'https://explorer.cardano.org/governance-action/gov_action1abc?network=preprod',
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

describe('epochStartUnix', () => {
  it('returns the mainnet Shelley anchor at its anchor epoch', () => {
    // mainnet epoch 208 boundary = 2020-07-29T21:44:51Z = unix 1596059091.
    expect(epochStartUnix(208, resolveNetwork('mainnet'))).toBe(1596059091);
  });
  it('advances 5 days (432000s) per epoch on mainnet', () => {
    expect(epochStartUnix(209, resolveNetwork('mainnet'))).toBe(1596059091 + 432000);
    expect(epochStartUnix(206, resolveNetwork('mainnet'))).toBe(1596059091 - 2 * 432000);
  });
  it('uses the preprod genesis anchor at epoch 0', () => {
    // preprod system start = 2022-06-21T00:00:00Z = unix 1655769600.
    expect(epochStartUnix(0, resolveNetwork('preprod'))).toBe(1655769600);
    expect(epochStartUnix(2, resolveNetwork('preprod'))).toBe(1655769600 + 2 * 432000);
  });
});

describe('epochFromUnix', () => {
  it('is the inverse of epochStartUnix for both networks', () => {
    for (const net of ['mainnet', 'preprod'] as const) {
      const cfg = resolveNetwork(net);
      for (const epoch of [cfg.epochAnchor.epoch, cfg.epochAnchor.epoch + 37, cfg.epochAnchor.epoch + 400]) {
        expect(epochFromUnix(epochStartUnix(epoch, cfg), cfg)).toBe(epoch);
      }
    }
  });

  it('floors a mid-epoch timestamp to the epoch it falls in', () => {
    const cfg = resolveNetwork('preprod');
    const mid = epochStartUnix(12, cfg) + 3 * 24 * 60 * 60; // 3 days into epoch 12
    expect(epochFromUnix(mid, cfg)).toBe(12);
  });
});

describe('currentEpochProgress', () => {
  const cfg = resolveNetwork('mainnet');

  it('reports epoch 0% elapsed with 5 days left at the boundary', () => {
    const p = currentEpochProgress(epochStartMs(300, cfg), cfg);
    expect(p.epoch).toBe(300);
    expect(p.endsUnixMs).toBe(epochStartMs(301, cfg));
    expect(p.fractionElapsed).toBe(0);
    expect(p.daysLeft).toBe(5);
  });

  it('reports the epoch half elapsed at its midpoint', () => {
    const now = epochStartMs(300, cfg) + 2.5 * 24 * 60 * 60 * 1000;
    const p = currentEpochProgress(now, cfg);
    expect(p.epoch).toBe(300);
    expect(p.fractionElapsed).toBeCloseTo(0.5, 10);
    expect(p.daysLeft).toBe(3); // 2.5 days remain, rounded up
  });

  it('never drops below one day left within a live epoch', () => {
    const now = epochStartMs(301, cfg) - 60 * 1000; // one minute before the boundary
    const p = currentEpochProgress(now, cfg);
    expect(p.epoch).toBe(300);
    expect(p.daysLeft).toBe(1);
    expect(p.fractionElapsed).toBeGreaterThan(0.99);
  });
});
