// CIP-108 author witness. Production PRODUCES + verifies CIP-0008 wallet signatures
// (COSE_Sign1 + COSE_Key) under a strict policy; a generic reader verifies raw-key
// CIP-0008 witnesses (official vectors / cardano-signer output).
//
// The witness payload is the exact 32-byte blake2b-256 canonical body hash from
// `canonicalBodyHashFor` (src/lib/governance/cip108Canonical.ts), NOT the anchor
// hash and NOT a UTF-8 string.
import { decodeCoseKeyPubKey, verifyCoseSign1 } from '../auth/cose.js';
import { hexToBytes, bytesToHex } from '../crypto/hex.js';

// Shelley reward address header high nibble (CIP-19 Table 1): 0xe0/0xf0.
const REWARD_ADDR_TYPES = new Set([14, 15]);

/** Parses a 64-hex body hash to its 32 raw bytes. */
function parseBodyHash(hex: string): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return { ok: false, reason: 'bodyHashHex is not valid hex' };
  }
  if (bytes.length !== 32) return { ok: false, reason: 'body hash must be 32 bytes' };
  return { ok: true, bytes };
}

/**
 * Layer 1: verifies a raw-key CIP-0008 witness (COSE_Sign1) against a body
 * hash, with no address policy. Used to read official CIP-108 example
 * vectors and third-party (e.g. cardano-signer CLI) witnesses whose
 * `publicKey` is a bare 32-byte Ed25519 key rather than a wallet COSE_Key.
 */
export async function verifyGenericCip0008(input: {
  publicKeyHex: string;
  signatureHex: string;
  bodyHashHex: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const parsed = parseBodyHash(input.bodyHashHex);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  let pub: Uint8Array;
  try {
    pub = hexToBytes(input.publicKeyHex);
  } catch {
    return { ok: false, reason: 'publicKeyHex is not valid hex' };
  }
  if (pub.length !== 32) return { ok: false, reason: 'public key must be 32 bytes' };

  const res = await verifyCoseSign1({
    signatureHex: input.signatureHex,
    publicKey: pub,
    expectedPayloadBytes: parsed.bytes,
    allowHashed: true,
  });
  return { ok: res.ok, reason: res.reason };
}

/**
 * Layers 2 + 3: decodes a wallet `signData` COSE_Key to a raw public key, then
 * verifies strictly (no `hashed=true` tolerance) and enforces the production
 * author-witness policy: the signed address must be a reward address on the
 * expected network. Rejects the official CIP-108 vector, which is signed over
 * a mainnet enterprise address and carries a raw key, not a COSE_Key.
 */
export async function verifyWalletAuthorWitness(input: {
  keyHex: string;
  signatureHex: string;
  bodyHashHex: string;
  expectedNetworkId: number;
}): Promise<{ ok: true; publicKeyHex: string } | { ok: false; reason: string }> {
  const parsed = parseBodyHash(input.bodyHashHex);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  // Layer 2: decode + validate the wallet COSE_Key -> raw ed25519 public key.
  const decoded = decodeCoseKeyPubKey(input.keyHex);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const pub = decoded.pubKey;

  // Layer 3: strict verify (no hashed=true) + address policy.
  const res = await verifyCoseSign1({
    signatureHex: input.signatureHex,
    publicKey: pub,
    expectedPayloadBytes: parsed.bytes,
    allowHashed: false,
  });
  if (!res.ok || !res.addressBytes) return { ok: false, reason: res.reason ?? 'invalid witness' };
  const header = res.addressBytes[0];
  if (!REWARD_ADDR_TYPES.has(header >> 4)) return { ok: false, reason: 'witness address is not a reward address' };
  if ((header & 0x0f) !== input.expectedNetworkId) return { ok: false, reason: 'witness address network tag mismatch' };
  return { ok: true, publicKeyHex: bytesToHex(pub) };
}
