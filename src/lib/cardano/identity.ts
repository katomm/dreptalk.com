// Cardano identity derivation: DRep IDs, stake addresses, address binding checks.
// Implements CIP-19, CIP-105, and CIP-129 conventions.
import { blake2b224 } from '../crypto/blake.js';
import { encodeBech32, decodeBech32 } from '../crypto/bech32.js';

// CIP-129 header byte for DRep key hash credentials.
const DREP_KEY_HEADER = 0x22;
// CIP-19 header byte for testnet reward addresses (stake_test).
const REWARD_TESTNET_HEADER = 0xe0;
// CIP-19 header byte for mainnet reward addresses (stake).
const REWARD_MAINNET_HEADER = 0xe1;

/**
 * Encodes a 28-byte DRep key hash as a CIP-129 bech32 drep1 address.
 * Prepends header byte 0x22 to the key hash before encoding.
 */
export function drepIdFromKeyHash(keyHash: Uint8Array): string {
  const payload = new Uint8Array(29);
  payload[0] = DREP_KEY_HEADER;
  payload.set(keyHash, 1);
  return encodeBech32('drep', payload);
}

/**
 * Derives a CIP-129 drep1 address from a raw Ed25519 public key.
 * Hashes the pubkey with Blake2b-224 (28 bytes), then calls drepIdFromKeyHash.
 */
export function drepIdFromPubKey(pubKey: Uint8Array): string {
  return drepIdFromKeyHash(blake2b224(pubKey));
}

/**
 * Derives a CIP-19 bech32 stake/reward address from a raw Ed25519 public key.
 * Hashes with Blake2b-224, prepends the appropriate header byte, and encodes.
 */
export function stakeAddressFromPubKey(pubKey: Uint8Array, network: 'mainnet' | 'preprod'): string {
  const keyHash = blake2b224(pubKey);
  const header = network === 'mainnet' ? REWARD_MAINNET_HEADER : REWARD_TESTNET_HEADER;
  const prefix = network === 'mainnet' ? 'stake' : 'stake_test';
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(keyHash, 1);
  return encodeBech32(prefix, payload);
}

/**
 * Returns true if the Blake2b-224 hash of pubKey matches a key-hash credential
 * embedded in addressBytes (CIP-19 encoded).
 *
 * Supports:
 *   - Reward/enterprise addresses (29 bytes): bytes[1..29] is the key hash.
 *   - Base addresses (57 bytes): payment key hash at bytes[1..29], stake key
 *     hash at bytes[29..57]. Which slots contain key hashes depends on the
 *     header type (high nibble of bytes[0]):
 *       0x00 key payment + key stake: check payment OR stake credential.
 *       0x01 script payment + key stake: check stake credential only.
 *       0x02 key payment + script stake: check payment credential only.
 *       0x03 script payment + script stake: no key hash present, return false.
 */
export function keyHashMatchesAddress(pubKey: Uint8Array, addressBytes: Uint8Array): boolean {
  const keyHash = blake2b224(pubKey);

  if (addressBytes.length === 29) {
    // Reward/enterprise address: bytes[1..29] is the key hash.
    return arrayEquals(keyHash, addressBytes.slice(1, 29));
  }

  if (addressBytes.length === 57) {
    // Base address: header high nibble encodes credential types (CIP-19 Table 1).
    const headerType = addressBytes[0] >> 4;
    switch (headerType) {
      case 0x00:
        // Key payment + key stake: key hash may be in either slot.
        return (
          arrayEquals(keyHash, addressBytes.slice(1, 29)) ||
          arrayEquals(keyHash, addressBytes.slice(29, 57))
        );
      case 0x01:
        // Script payment + key stake: only the stake slot holds a key hash.
        return arrayEquals(keyHash, addressBytes.slice(29, 57));
      case 0x02:
        // Key payment + script stake: only the payment slot holds a key hash.
        return arrayEquals(keyHash, addressBytes.slice(1, 29));
      case 0x03:
        // Script payment + script stake: no key-hash credential present.
        return false;
      default:
        return false;
    }
  }

  return false;
}

/**
 * Converts a legacy CIP-105 drep_vkh1 address (28-byte hash, no header byte)
 * to a CIP-129 drep1 address (header byte 0x22 + 28-byte hash).
 */
export function cip105ToCip129(drepVkh: string): string {
  const { data: keyHash } = decodeBech32(drepVkh);
  return drepIdFromKeyHash(keyHash);
}

// Compares two Uint8Arrays for value equality.
function arrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
