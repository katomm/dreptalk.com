import { describe, it, expect } from 'vitest';
import { rewardAddressToStakeBech32 } from './stakeAccount.js';
import { decodeBech32 } from '../crypto/bech32.js';
import { bytesToHex } from '../crypto/hex.js';

// A real preprod stake address; its raw bytes are the 29-byte reward address a
// CIP-30 wallet returns from getRewardAddresses() (in hex).
const FIXTURE_STAKE_ADDR = 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj';

describe('rewardAddressToStakeBech32', () => {
  it('re-encodes a preprod reward address hex back to its stake_test bech32 form', () => {
    const hex = bytesToHex(decodeBech32(FIXTURE_STAKE_ADDR).data);
    expect(rewardAddressToStakeBech32(hex, 'preprod')).toBe(FIXTURE_STAKE_ADDR);
  });

  it('uses the bare stake prefix on mainnet', () => {
    // Mainnet stake-key reward address: header 0xe1 + 28-byte key credential.
    const hex = `e1${'ab'.repeat(28)}`;
    expect(rewardAddressToStakeBech32(hex, 'mainnet').startsWith('stake1')).toBe(true);
  });

  it('rejects an address that is not 29 bytes', () => {
    expect(() => rewardAddressToStakeBech32('e1ff', 'mainnet')).toThrow();
  });
});
