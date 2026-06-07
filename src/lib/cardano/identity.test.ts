// Tests for Cardano identity derivation: DRep IDs, stake addresses, and address binding.
import { describe, it, expect } from 'vitest';
import {
  drepIdFromKeyHash,
  drepIdFromPubKey,
  stakeAddressFromPubKey,
  keyHashMatchesAddress,
  cip105ToCip129,
  ccHotKeyHashHex,
} from './identity.js';
import { hexToBytes, bytesToHex } from '../crypto/hex.js';
import { decodeBech32, encodeBech32 } from '../crypto/bech32.js';

// From src/lib/auth/__fixtures__/cip8-vectors.json
const STAKE_VECTOR = {
  expectedPubKeyHex: '3a7a243a6b00e4a913d74a054984079299315828c366d1cc9cc88d06af742d5a',
  expectedStakeAddress: 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj',
  addressHex: 'e0020bbbc054b1c5cdcbc826c6a016973f3ef684d9dd7f3ed8e448cb71',
};
const DREP_VECTOR = {
  expectedPubKeyHex: 'a1458f6a1e1763fc379d7593b855ea21066cc76b78bfb5860f17315c86b561f6',
  expectedDrepAddrHex: '22af4e07977b6c2683c065e17ec1ea0421ac7c2fc579f9dd98ff8e2f82',
};

describe('drepIdFromKeyHash', () => {
  it('encodes 28 zero bytes as the CIP-129 all-q drep id', () => {
    // CIP-129 canonical zero vector.
    const result = drepIdFromKeyHash(new Uint8Array(28));
    expect(result).toBe('drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n');
  });

  it('produces a drep bech32 string with prefix drep', () => {
    const result = drepIdFromKeyHash(new Uint8Array(28));
    expect(result.startsWith('drep1')).toBe(true);
  });
});

describe('drepIdFromPubKey', () => {
  it('derives the correct drep id for the fixture drep pubkey', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const drepId = drepIdFromPubKey(pubKey);
    // Decode and verify the payload hex matches the fixture.
    const { data } = decodeBech32(drepId);
    expect(bytesToHex(data)).toBe(DREP_VECTOR.expectedDrepAddrHex);
  });

  it('returns a string starting with drep1', () => {
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    expect(drepIdFromPubKey(pubKey).startsWith('drep1')).toBe(true);
  });
});

describe('stakeAddressFromPubKey', () => {
  it('derives the fixture preprod stake address from the fixture pubkey', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const result = stakeAddressFromPubKey(pubKey, 'preprod');
    expect(result).toBe(STAKE_VECTOR.expectedStakeAddress);
  });

  it('uses stake_test prefix for preprod', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const addr = stakeAddressFromPubKey(pubKey, 'preprod');
    expect(addr.startsWith('stake_test1')).toBe(true);
  });

  it('uses stake prefix for mainnet', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const addr = stakeAddressFromPubKey(pubKey, 'mainnet');
    expect(addr.startsWith('stake1')).toBe(true);
  });

  it('uses header 0xE0 for testnet and 0xE1 for mainnet', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const testnet = decodeBech32(stakeAddressFromPubKey(pubKey, 'preprod'));
    const mainnet = decodeBech32(stakeAddressFromPubKey(pubKey, 'mainnet'));
    expect(testnet.data[0]).toBe(0xe0);
    expect(mainnet.data[0]).toBe(0xe1);
  });
});

describe('keyHashMatchesAddress', () => {
  it('returns true when the pubkey hash matches a reward address', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const addrBytes = hexToBytes(STAKE_VECTOR.addressHex);
    expect(keyHashMatchesAddress(pubKey, addrBytes)).toBe(true);
  });

  it('returns false when a different pubkey is used against the same address', () => {
    const wrongPubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const addrBytes = hexToBytes(STAKE_VECTOR.addressHex);
    expect(keyHashMatchesAddress(wrongPubKey, addrBytes)).toBe(false);
  });

  it('matches via decoded fixture stake address bytes', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const { data: addrBytes } = decodeBech32(STAKE_VECTOR.expectedStakeAddress);
    expect(keyHashMatchesAddress(pubKey, addrBytes)).toBe(true);
  });

  describe('base address (57 bytes, header 0x00)', () => {
    // The fixture stake key hash is blake2b224(expectedPubKeyHex),
    // which equals bytes[1..29] of the fixture reward address (addressHex).
    // Construct a synthetic 57-byte base address: header 0x00 + dummy 28-byte
    // payment slot (all 0x11) + real stake key hash in the stake slot.
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    // Real stake key hash extracted from the fixture reward address.
    const realStakeKeyHash = hexToBytes(STAKE_VECTOR.addressHex).slice(1, 29);

    const baseAddrMatch = new Uint8Array(57);
    baseAddrMatch[0] = 0x00; // header: key payment + key stake
    baseAddrMatch.fill(0x11, 1, 29); // dummy payment slot
    baseAddrMatch.set(realStakeKeyHash, 29); // real stake credential

    it('returns true when keyHash matches the stake credential slot', () => {
      expect(keyHashMatchesAddress(pubKey, baseAddrMatch)).toBe(true);
    });

    it('returns false when neither slot matches', () => {
      const baseAddrNoMatch = new Uint8Array(57);
      baseAddrNoMatch[0] = 0x00;
      baseAddrNoMatch.fill(0x11, 1, 29); // payment slot: all 0x11
      baseAddrNoMatch.fill(0x22, 29, 57); // stake slot: all 0x22 (wrong)
      expect(keyHashMatchesAddress(pubKey, baseAddrNoMatch)).toBe(false);
    });
  });
});

describe('ccHotKeyHashHex', () => {
  it('returns the lowercase blake2b-224 hash of the pubkey as hex (matches Koios cc_hot_hex)', () => {
    // For the DREP fixture pubkey, blake2b224 == the 28-byte hash inside the
    // CIP-129 drep address (everything after the 0x22 header). The CC hot key
    // hash is computed the same way (blake2b224 of the Ed25519 pubkey), which is
    // exactly what Koios /committee_info returns as cc_hot_hex.
    const pubKey = hexToBytes(DREP_VECTOR.expectedPubKeyHex);
    const expectedHash = DREP_VECTOR.expectedDrepAddrHex.slice(2); // drop 0x22 header
    expect(ccHotKeyHashHex(pubKey)).toBe(expectedHash);
  });

  it('produces a 56-character (28-byte) lowercase hex string', () => {
    const pubKey = hexToBytes(STAKE_VECTOR.expectedPubKeyHex);
    const hash = ccHotKeyHashHex(pubKey);
    expect(hash).toMatch(/^[0-9a-f]{56}$/);
  });
});

describe('cip105ToCip129', () => {
  it('converts a drep_vkh1 address to a CIP-129 drep1 address', () => {
    // Build a drep_vkh1 from a known 28-byte hash.
    const knownHash = new Uint8Array(28).fill(0x42);
    const legacyAddr = encodeBech32('drep_vkh', knownHash);
    expect(legacyAddr.startsWith('drep_vkh1')).toBe(true);

    const cip129 = cip105ToCip129(legacyAddr);
    expect(cip129.startsWith('drep1')).toBe(true);

    // The decoded payload should be 0x22 prepended to the 28-byte hash.
    const { data } = decodeBech32(cip129);
    expect(data[0]).toBe(0x22);
    expect(Array.from(data.slice(1))).toEqual(Array.from(knownHash));
  });

  it('round-trips: a hash re-encoded as drep_vkh1 and back to cip129 matches drepIdFromKeyHash', () => {
    const hash = new Uint8Array(28);
    hash[0] = 0xab;
    hash[27] = 0xcd;
    const legacy = encodeBech32('drep_vkh', hash);
    const result = cip105ToCip129(legacy);
    expect(result).toBe(drepIdFromKeyHash(hash));
  });
});
