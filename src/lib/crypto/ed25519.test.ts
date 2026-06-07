import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyEd25519 } from './ed25519';

// Deterministic test key material (do not use outside tests).
const SEED = new Uint8Array(32).fill(7);
const PUBKEY = ed25519.getPublicKey(SEED);
const MSG = new TextEncoder().encode('dreptalk:dreptalk.com:test-nonce:1700000000');
const SIG = ed25519.sign(MSG, SEED);

describe('verifyEd25519', () => {
  it('returns ok:true for a valid signature over the message', async () => {
    const result = await verifyEd25519(SIG, MSG, PUBKEY);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false when a signature byte is flipped', async () => {
    const bad = new Uint8Array(SIG);
    bad[0] ^= 0xff;
    const result = await verifyEd25519(bad, MSG, PUBKEY);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when the message differs from what was signed', async () => {
    const otherMsg = new TextEncoder().encode('dreptalk:dreptalk.com:other-nonce:1700000000');
    const result = await verifyEd25519(SIG, otherMsg, PUBKEY);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for a wrong public key', async () => {
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const result = await verifyEd25519(SIG, MSG, otherPub);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false (never throws) for a malformed public key length', async () => {
    const result = await verifyEd25519(SIG, MSG, new Uint8Array(10));
    expect(result.ok).toBe(false);
  });
});
