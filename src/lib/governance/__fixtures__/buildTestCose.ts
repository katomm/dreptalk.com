// Test-only helper: builds a real CIP-0008 COSE_Sign1 + COSE_Key from an
// ephemeral Ed25519 key, exactly as a wallet's signData would, over a synthetic
// reward or enterprise address. Used to exercise verifyWalletAuthorWitness
// (src/lib/governance/authorWitness.ts) against genuine, wallet-shaped
// signatures instead of hand-pinned fixtures.
import { encode } from 'cborg';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b224 } from '../../crypto/blake.js';
import { bytesToHex, hexToBytes } from '../../crypto/hex.js';

export interface BuiltTestCose {
  coseSign1Hex: string;
  coseKeyHex: string;
  publicKeyHex: string;
}

/**
 * Builds a COSE_Sign1 over `payloadHex`, signed by a freshly generated Ed25519
 * key, with a synthetic Shelley address (reward or enterprise, at `networkId`)
 * placed in the protected header. When `hashed` is true, the payload is signed
 * as its own Blake2b-224 digest with `hashed: true` set in the unprotected
 * header, simulating a hardware wallet.
 */
export async function buildTestCose(opts: {
  payloadHex: string;
  addrType: 'reward' | 'enterprise';
  networkId: number;
  hashed: boolean;
}): Promise<BuiltTestCose> {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const keyHash = blake2b224(pub); // 28 bytes

  // Shelley address header: high nibble = type (14 = reward, 6 = enterprise
  // key-hash), low nibble = network id (CIP-19).
  const high = opts.addrType === 'reward' ? 0xe0 : 0x60;
  const address = new Uint8Array([high | (opts.networkId & 0x0f), ...keyHash]);

  const protectedMap = new Map<number | string, unknown>([
    [1, -8], // alg: EdDSA
    ['address', address],
  ]);
  const protectedBstr = encode(protectedMap);
  const payload = hexToBytes(opts.payloadHex);
  const signedPayload = opts.hashed ? blake2b224(payload) : payload; // simulate a hardware wallet when hashed
  const unprotected = new Map<string, unknown>(opts.hashed ? [['hashed', true]] : []);
  const sigStructure = encode(['Signature1', protectedBstr, new Uint8Array(0), signedPayload]);
  const signature = ed25519.sign(sigStructure, priv);
  const coseSign1 = encode([protectedBstr, unprotected, signedPayload, signature]);

  const coseKey = new Map<number, unknown>([
    [1, 1], // kty: OKP
    [3, -8], // alg: EdDSA
    [-1, 6], // crv: Ed25519
    [-2, pub], // x: public key
  ]);

  return {
    coseSign1Hex: bytesToHex(coseSign1),
    coseKeyHex: bytesToHex(encode(coseKey)),
    publicKeyHex: bytesToHex(pub),
  };
}
