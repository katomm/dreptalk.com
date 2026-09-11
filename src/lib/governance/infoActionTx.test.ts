// Unit tests for the pure construction helper and the mainnet guard in
// infoActionTx.ts. buildInfoActionProposeParts requires no network or wallet,
// so it runs offline. The full submitInfoAction build/sign/submit path needs
// a live wallet and Koios provider and is not covered here.

import { describe, it, expect } from 'vitest';
import { buildInfoActionProposeParts, submitInfoAction } from './infoActionTx.js';

// Deterministic test fixtures.
const REWARD_ADDRESS_HEX = `e0${'00'.repeat(28)}`; // testnet-style reward address (29 bytes)
const ANCHOR_URL = 'ipfs://bafyfake';
// 64 hex chars = 32 bytes, a valid blake2b-256 placeholder.
const ANCHOR_HASH_HEX = 'ab'.repeat(32);

describe('buildInfoActionProposeParts', () => {
  it('builds an InfoAction proposal with a reward account and anchor', () => {
    const parts = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    expect(parts.rewardAccount).toBeDefined();
    expect(parts.governanceAction).toBeDefined();
    expect(parts.anchor).toBeDefined();
  });

  it('tags the governance action as InfoAction', () => {
    const parts = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    expect((parts.governanceAction as { _tag: string })._tag).toBe('InfoAction');
  });

  it('round-trips the anchor URL and hash via toJSON', () => {
    const { anchor } = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    const json = anchor.toJSON();
    expect(json.anchorUrl).toBe(ANCHOR_URL);
    expect(json.anchorDataHash).toBe(ANCHOR_HASH_HEX);
  });
});

describe('submitInfoAction', () => {
  it('refuses mainnet regardless of caller, without touching the wallet', async () => {
    await expect(
      submitInfoAction({
        // Validation throws before the wallet is touched, so a bare object is fine.
        // biome-ignore lint/suspicious/noExplicitAny: unused past validation
        walletApi: {} as any,
        network: 'mainnet',
        origin: 'https://x',
        rewardAddressHex: 'e0',
        anchorUrl: 'ipfs://x',
        anchorHashHex: ANCHOR_HASH_HEX,
        govActionDepositLovelace: 1n,
      }),
    ).rejects.toThrow(/preprod/i);
  });
});
