import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { TransactionWitnessSet, VKey, Ed25519Signature } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import { validateWitness } from './multisigWitness.js';

function makeWitnessSetHex(priv: Uint8Array, bodyHash: Uint8Array): { hex: string; keyHashHex: string } {
  const pub = ed25519.getPublicKey(priv);
  const sig = ed25519.sign(bodyHash, priv);
  const ws = TransactionWitnessSet.fromVKeyWitnesses([
    new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(pub), signature: Ed25519Signature.fromBytes(sig) }),
  ]);
  const keyHashHex = bytesToHex(blake2b(pub, { dkLen: 28 }));
  return { hex: TransactionWitnessSet.toCBORHex(ws), keyHashHex };
}

describe('validateWitness', () => {
  const priv = hexToBytes('00'.repeat(32));
  const bodyHash = hexToBytes('ab'.repeat(32));

  it('accepts a valid member witness over the body hash', () => {
    const { hex, keyHashHex } = makeWitnessSetHex(priv, bodyHash);
    const r = validateWitness({ witnessSetHex: hex, bodyHashHex: bytesToHex(bodyHash), sigLeaves: new Set([keyHashHex]), already: new Set() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.witness.keyHashHex).toBe(keyHashHex);
  });

  it('rejects a witness whose key is not a script member', () => {
    const { hex } = makeWitnessSetHex(priv, bodyHash);
    const r = validateWitness({ witnessSetHex: hex, bodyHashHex: bytesToHex(bodyHash), sigLeaves: new Set(['ff'.repeat(28)]), already: new Set() });
    expect(r).toEqual({ ok: false, reason: 'not a member' });
  });

  it('rejects a signature over a different body hash', () => {
    const { hex, keyHashHex } = makeWitnessSetHex(priv, bodyHash);
    const r = validateWitness({ witnessSetHex: hex, bodyHashHex: 'cd'.repeat(32), sigLeaves: new Set([keyHashHex]), already: new Set() });
    expect(r).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects a duplicate key hash', () => {
    const { hex, keyHashHex } = makeWitnessSetHex(priv, bodyHash);
    const r = validateWitness({ witnessSetHex: hex, bodyHashHex: bytesToHex(bodyHash), sigLeaves: new Set([keyHashHex]), already: new Set([keyHashHex]) });
    expect(r).toEqual({ ok: false, reason: 'duplicate' });
  });
});
