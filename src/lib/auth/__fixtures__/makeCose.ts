// Test-only helper: builds a real CIP-8 COSE_Sign1 + COSE_Key from an ephemeral
// Ed25519 key, exactly as a CIP-30 / CIP-95 wallet's signData would. Used to
// exercise verifyCip8 and the auth gates against genuine, wallet-shaped
// signatures instead of hand-pinned fixtures.
import { ed25519 } from '@noble/curves/ed25519.js';
import { encode } from 'cborg';
import { blake2b224, blake2b256 } from '../../crypto/blake.js';
import { bytesToHex } from '../../crypto/hex.js';

export interface MadeCose {
  signatureHex: string;
  keyHex: string;
  pubKey: Uint8Array;
  keyHash: Uint8Array; // blake2b224(pubKey)
  addressBytes: Uint8Array;
}

/**
 * Builds a COSE_Sign1 over `payload`, signed by the Ed25519 key derived from
 * `seed`, with `addressBytes` placed verbatim in the protected header (as a
 * wallet does). By default the payload is signed un-hashed (hashed=false);
 * pass `payloadHash` to sign a Blake2b digest of the payload with hashed=true,
 * as hardware wallets (e.g. Ledger) do.
 */
export function makeCoseSignature(opts: {
  seed: Uint8Array; // 32-byte Ed25519 secret seed
  payload: string;
  addressBytes: Uint8Array;
  payloadHash?: 'blake2b224' | 'blake2b256';
}): MadeCose {
  const pubKey = ed25519.getPublicKey(opts.seed);
  const keyHash = blake2b224(pubKey);

  // Protected header: alg EdDSA (-8) + the raw address bytes (no CBOR tag).
  const protectedMap = new Map<number | string, unknown>([
    [1, -8],
    ['address', opts.addressBytes],
  ]);
  const protectedBstr = encode(protectedMap);
  const payloadUtf8 = new TextEncoder().encode(opts.payload);
  const payloadBytes =
    opts.payloadHash === 'blake2b224' ? blake2b224(payloadUtf8)
    : opts.payloadHash === 'blake2b256' ? blake2b256(payloadUtf8)
    : payloadUtf8;

  // Sig_structure = ['Signature1', protected, external_aad(empty), payload].
  const toBeSigned = encode(['Signature1', protectedBstr, new Uint8Array(0), payloadBytes]);
  const sig = ed25519.sign(toBeSigned, opts.seed);

  const unprotected = new Map<string, unknown>([['hashed', opts.payloadHash !== undefined]]);
  const coseSign1 = [protectedBstr, unprotected, payloadBytes, sig];

  const coseKey = new Map<number, unknown>([
    [1, 1], // kty: OKP
    [3, -8], // alg: EdDSA
    [-1, 6], // crv: Ed25519
    [-2, pubKey], // x: public key
  ]);

  return {
    signatureHex: bytesToHex(encode(coseSign1)),
    keyHex: bytesToHex(encode(coseKey)),
    pubKey,
    keyHash,
    addressBytes: opts.addressBytes,
  };
}

/** CIP-19 type-6 (enterprise) address: header byte (0x61 mainnet / 0x60 preprod) + 28-byte key hash. */
export function type6Address(keyHash: Uint8Array, network: 'mainnet' | 'preprod'): Uint8Array {
  const out = new Uint8Array(29);
  out[0] = network === 'mainnet' ? 0x61 : 0x60;
  out.set(keyHash, 1);
  return out;
}
