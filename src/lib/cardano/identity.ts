// Cardano identity derivation: DRep IDs, stake addresses, address binding checks.
// Implements CIP-19, CIP-105, and CIP-129 conventions.
import { blake2b224 } from '../crypto/blake.js';
import { encodeBech32, decodeBech32 } from '../crypto/bech32.js';
import { bytesEqual } from '../crypto/bytes.js';
import { bytesToHex } from '../crypto/hex.js';

// CIP-129 header byte for DRep key hash credentials.
export const DREP_KEY_HEADER = 0x22;
// CIP-129 header byte for DRep script-hash credentials.
export const DREP_SCRIPT_HEADER = 0x23;
// CIP-19 header byte for testnet reward addresses (stake_test).
const REWARD_TESTNET_HEADER = 0xe0;
// CIP-19 header byte for mainnet reward addresses (stake).
const REWARD_MAINNET_HEADER = 0xe1;
// CIP-19 type-6 (enterprise) header bytes: high nibble 0b0110, low nibble is
// the network tag (0 testnet, 1 mainnet). CIP-95 reuses this form to carry the
// DRep key hash when signing data with the DRep key.
const ENTERPRISE_TESTNET_HEADER = 0x60;
const ENTERPRISE_MAINNET_HEADER = 0x61;

/**
 * True for a Cardano payment address string: addr1... (mainnet) or
 * addr_test1... (testnet). Format check only, no checksum; callers apply their
 * own length cap. Shared by the metadata builder (write) and parser (read) so
 * the rule cannot drift between them.
 */
export function isCardanoPaymentAddress(raw: string): boolean {
  return /^addr(_test)?1[0-9a-z]+$/.test(raw);
}

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
 * Returns the hex-encoded Blake2b-224 hash of a raw Ed25519 public key.
 *
 * This is the credential hash format Koios stores as `cc_hot_hex` in the
 * /committee_info response: a CC hot key is an ordinary Ed25519 key, and its
 * credential is blake2b-224(pubkey). Used to match a CC member's signing key
 * against the authorized committee hot credentials.
 */
export function ccHotKeyHashHex(pubKey: Uint8Array): string {
  return bytesToHex(blake2b224(pubKey));
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

  if (addressBytes.length === 28) {
    // Bare credential key hash, no header byte. Some CIP-95 wallets emit the
    // DRep key hash this way in the COSE address header (CIP PR #897).
    return bytesEqual(keyHash, addressBytes);
  }

  if (addressBytes.length === 29) {
    // Reward/enterprise address: bytes[1..29] is the key hash.
    return bytesEqual(keyHash, addressBytes.slice(1, 29));
  }

  if (addressBytes.length === 57) {
    // Base address: header high nibble encodes credential types (CIP-19 Table 1).
    const headerType = addressBytes[0] >> 4;
    switch (headerType) {
      case 0x00:
        // Key payment + key stake: key hash may be in either slot.
        return (
          bytesEqual(keyHash, addressBytes.slice(1, 29)) ||
          bytesEqual(keyHash, addressBytes.slice(29, 57))
        );
      case 0x01:
        // Script payment + key stake: only the stake slot holds a key hash.
        return bytesEqual(keyHash, addressBytes.slice(29, 57));
      case 0x02:
        // Key payment + script stake: only the payment slot holds a key hash.
        return bytesEqual(keyHash, addressBytes.slice(1, 29));
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
 * Returns true when addressBytes is a DRep-key credential as it appears in a
 * CIP-8 / COSE protected-header "address" field for a CIP-95 DRep signature.
 *
 * Per CIP-95, signing with the DRep key uses a CIP-19 type-6 (enterprise)
 * address: header byte high nibble 0b0110 (0x60 testnet, 0x61 mainnet) followed
 * by the 28-byte DRep key hash. Some wallets emit the bare 28-byte key hash with
 * no header byte (CIP PR #897, cardano-signer). Both forms are accepted.
 *
 * This is NOT the CIP-129 governance id (header 0x22), which is a bech32
 * identifier encoding and never appears in a COSE address field. A reward
 * address (0xe0/0xe1) or a base address (57 bytes) is also rejected: the binding
 * to the DRep identity is done separately via drepIdFromPubKey(pubKey).
 */
export function isDrepCredentialAddress(addressBytes: Uint8Array): boolean {
  if (addressBytes.length === 28) return true;
  if (addressBytes.length === 29) return (addressBytes[0] >> 4) === 0b0110;
  return false;
}

/**
 * Builds the hex-encoded CIP-19 type-6 (enterprise) address for a 28-byte DRep
 * key hash, to pass as the `addr` argument to a wallet's signData when signing
 * with the DRep key (CIP-95). Header byte 0x60 on testnet/preprod, 0x61 on
 * mainnet, followed by the key hash.
 */
export function drepCredentialAddress(keyHash: Uint8Array, network: 'mainnet' | 'preprod'): string {
  const payload = new Uint8Array(29);
  payload[0] = network === 'mainnet' ? ENTERPRISE_MAINNET_HEADER : ENTERPRISE_TESTNET_HEADER;
  payload.set(keyHash, 1);
  return bytesToHex(payload);
}

/**
 * Converts a legacy CIP-105 drep_vkh1 address (28-byte hash, no header byte)
 * to a CIP-129 drep1 address (header byte 0x22 + 28-byte hash).
 */
export function cip105ToCip129(drepVkh: string): string {
  const { data: keyHash } = decodeBech32(drepVkh);
  return drepIdFromKeyHash(keyHash);
}

/**
 * Extracts the 28-byte credential hash (hex) from a bech32 DRep id: a CIP-129
 * drep1 (header byte + 28-byte hash) or a bare CIP-105 hash. Returns null when
 * the id does not decode to a credential. Used to target a DRep for vote
 * delegation when the stored Koios `hex` is absent.
 */
export function drepCredentialHexFromId(drepId: string): string | null {
  try {
    const { data } = decodeBech32(drepId);
    if (data.length === 29) return bytesToHex(data.slice(1));
    if (data.length === 28) return bytesToHex(data);
    return null;
  } catch {
    return null;
  }
}

export interface ParsedDrepId {
  kind: 'key' | 'script';
  hashHex: string; // 28-byte credential hash, lowercase hex
}

/**
 * Decodes a bech32 DRep id into its credential kind and 28-byte hash hex.
 * CIP-129 (29 bytes): header 0x22 -> key, 0x23 -> script. Legacy CIP-105
 * (bare 28-byte hash, no header) is treated as a key credential. Returns null
 * when the input is not a valid DRep credential.
 */
export function parseDrepId(drepId: string): ParsedDrepId | null {
  let data: Uint8Array;
  try {
    ({ data } = decodeBech32(drepId));
  } catch {
    return null;
  }
  if (data.length === 29) {
    if (data[0] === DREP_KEY_HEADER) return { kind: 'key', hashHex: bytesToHex(data.slice(1)) };
    if (data[0] === DREP_SCRIPT_HEADER) return { kind: 'script', hashHex: bytesToHex(data.slice(1)) };
    return null;
  }
  if (data.length === 28) return { kind: 'key', hashHex: bytesToHex(data) };
  return null;
}

