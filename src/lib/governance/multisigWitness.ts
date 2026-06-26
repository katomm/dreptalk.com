// Validate vkey witnesses for native-script (multisig) DRep votes.
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { TransactionWitnessSet, VKey, Ed25519Signature } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';

export type ParsedWitness = { keyHashHex: string; vkeyHex: string; signatureHex: string };

/** Extract vkey witnesses from a CIP-30 / SDK witness-set CBOR hex. */
export function parseWitnessSetHex(witnessSetHex: string): ParsedWitness[] {
  const ws = TransactionWitnessSet.fromCBORHex(witnessSetHex);
  const vkeys = ws.vkeyWitnesses ?? [];
  return vkeys.map((w) => {
    const vkeyBytes = VKey.toBytes(w.vkey);
    return {
      keyHashHex: bytesToHex(blake2b(vkeyBytes, { dkLen: 28 })),
      vkeyHex: bytesToHex(vkeyBytes),
      signatureHex: bytesToHex(Ed25519Signature.toBytes(w.signature)),
    };
  });
}

/** Validate a single vkey witness against a tx body hash and a script's authorized signer set. */
export function validateWitness(args: {
  witnessSetHex: string;
  bodyHashHex: string;
  sigLeaves: Set<string>;
  already: Set<string>;
}): { ok: true; witness: ParsedWitness } | { ok: false; reason: 'no vkey' | 'bad signature' | 'not a member' | 'duplicate' } {
  let parsed: ParsedWitness[];
  try {
    parsed = parseWitnessSetHex(args.witnessSetHex);
  } catch {
    return { ok: false, reason: 'no vkey' };
  }
  const w = parsed[0];
  if (!w) return { ok: false, reason: 'no vkey' };
  if (!args.sigLeaves.has(w.keyHashHex)) return { ok: false, reason: 'not a member' };
  if (args.already.has(w.keyHashHex)) return { ok: false, reason: 'duplicate' };
  const valid = ed25519.verify(hexToBytes(w.signatureHex), hexToBytes(args.bodyHashHex), hexToBytes(w.vkeyHex));
  if (!valid) return { ok: false, reason: 'bad signature' };
  return { ok: true, witness: w };
}
