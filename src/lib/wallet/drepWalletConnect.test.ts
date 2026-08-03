// Unit tests for the shared manage-flow connect (settings update, retire):
// CIP-95 enable, network guard, identity derivation, and the identity check
// against the session's DRep id, exercised against fake CIP-30 wallet objects.
import { describe, it, expect } from 'vitest';
import { connectVerifiedDrep, identityMatches, type EnabledWalletApi } from './drepWalletConnect.js';
import { blake2b224 } from '@/lib/crypto/blake.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import { drepIdFromKeyHash } from '@/lib/cardano/identity.js';

const PUB_KEY_HEX = 'aa'.repeat(32);
const DREP_ID = drepIdFromKeyHash(blake2b224(hexToBytes(PUB_KEY_HEX)));

function fakeApi(over?: { networkId?: number; noCip95?: boolean; pubKeyHex?: string }) {
  return {
    getNetworkId: async () => over?.networkId ?? 0,
    ...(over?.noCip95
      ? {}
      : { cip95: { getPubDRepKey: async () => over?.pubKeyHex ?? PUB_KEY_HEX } }),
  } as unknown as EnabledWalletApi;
}

function fakeRawWallet(api: EnabledWalletApi) {
  let enables = 0;
  return {
    raw: {
      enable: async () => {
        enables++;
        return api;
      },
    },
    enables: () => enables,
  };
}

describe('identityMatches', () => {
  it('accepts the exact same drep id', () => {
    expect(identityMatches('drep1abc', 'drep1abc')).toBe(true);
  });

  it('rejects a different drep id', () => {
    expect(identityMatches('drep1abc', 'drep1xyz')).toBe(false);
  });

  it('is case-insensitive on the bech32 string', () => {
    expect(identityMatches('DRep1Abc', 'drep1abc')).toBe(true);
  });
});

describe('connectVerifiedDrep', () => {
  it('enables, derives the identity, and returns the api + key hash on a match', async () => {
    const api = fakeApi();
    const wallet = fakeRawWallet(api);
    const connected = await connectVerifiedDrep({
      rawWallet: wallet.raw,
      network: 'preprod',
      // Case-insensitive, same as identityMatches.
      expectedDrepId: DREP_ID.toUpperCase(),
    });
    expect(connected.api).toBe(api);
    expect(drepIdFromKeyHash(connected.drepKeyHash)).toBe(DREP_ID);
    expect(wallet.enables()).toBe(1);
  });

  it('reuses a cached api without a second enable round-trip', async () => {
    const api = fakeApi();
    const wallet = fakeRawWallet(api);
    const connected = await connectVerifiedDrep({
      rawWallet: wallet.raw,
      network: 'preprod',
      expectedDrepId: DREP_ID,
      cachedApi: api,
    });
    expect(connected.api).toBe(api);
    expect(wallet.enables()).toBe(0);
  });

  it('rejects a wallet on the wrong network before touching the DRep key', async () => {
    const wallet = fakeRawWallet(fakeApi({ networkId: 1 }));
    await expect(
      connectVerifiedDrep({ rawWallet: wallet.raw, network: 'preprod', expectedDrepId: DREP_ID }),
    ).rejects.toThrow(/switch your wallet/i);
  });

  it('rejects a wallet without CIP-95 support', async () => {
    const wallet = fakeRawWallet(fakeApi({ noCip95: true }));
    await expect(
      connectVerifiedDrep({ rawWallet: wallet.raw, network: 'preprod', expectedDrepId: DREP_ID }),
    ).rejects.toThrow(/CIP-95/);
  });

  it('rejects a wallet that derives a different DRep, naming the derived id', async () => {
    const wallet = fakeRawWallet(fakeApi({ pubKeyHex: 'bb'.repeat(32) }));
    await expect(
      connectVerifiedDrep({ rawWallet: wallet.raw, network: 'preprod', expectedDrepId: DREP_ID }),
    ).rejects.toThrow(/different DRep \(drep1/);
  });
});
