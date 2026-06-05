// CIP-8 COSE_Sign1 verifier tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// This exercises WebCrypto Ed25519 in the Workers runtime, with @noble/curves as fallback.
import { describe, it, expect } from 'vitest';
import vectors from './__fixtures__/cip8-vectors.json';
import { verifyCip8 } from './cose.js';
import { bytesToHex } from '../crypto/hex.js';

/** Probes which Ed25519 path is available in the current runtime. */
async function detectEd25519Path(): Promise<'WebCrypto-Ed25519' | 'WebCrypto-NODE-ED25519' | 'noble-fallback'> {
  const dummy = new Uint8Array(32).fill(1);
  try {
    await crypto.subtle.importKey('raw', dummy, 'Ed25519', false, ['verify']);
    return 'WebCrypto-Ed25519';
  } catch {
    try {
      await crypto.subtle.importKey(
        'raw',
        dummy,
        { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as AlgorithmIdentifier,
        false,
        ['verify'],
      );
      return 'WebCrypto-NODE-ED25519';
    } catch {
      return 'noble-fallback';
    }
  }
}

// Extract the two well-known vectors by label.
const stakeVector = vectors.vectors.find(v => v.label === 'stake-key-valid')!;
const drepVector = vectors.vectors.find(v => v.label === 'drep-key-valid');

// Helpers to tamper with hex bytes.
function flipByte(hex: string, byteOffset: number): string {
  const chars = hex.split('');
  const charIdx = byteOffset * 2;
  // XOR the high nibble with 0x01 to flip a bit.
  const orig = parseInt(chars[charIdx], 16);
  chars[charIdx] = ((orig ^ 0x01) & 0xf).toString(16);
  return chars.join('');
}

function replaceLastByte(hex: string): string {
  return hex.slice(0, -2) + 'ff';
}

describe('Ed25519 runtime path detection', () => {
  it('reports which Ed25519 path is available in workerd', async () => {
    const path = await detectEd25519Path();
    // This test always passes; it exists to report which crypto path is active.
    console.log(`[cose.workers] Ed25519 verification path in workerd: ${path}`);
    expect(['WebCrypto-Ed25519', 'WebCrypto-NODE-ED25519', 'noble-fallback']).toContain(path);
  });
});

describe('verifyCip8 (stake-key-valid fixture)', () => {
  it('returns ok=true for a valid stake key fixture', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });

    // Report which Ed25519 path was used (via reason if ok=false, or just ok=true).
    if (!result.ok) {
      throw new Error(`verifyCip8 failed: ${result.reason}`);
    }

    expect(result.ok).toBe(true);
    expect(result.pubKey).toBeInstanceOf(Uint8Array);
    expect(result.pubKey!.length).toBe(32);
    expect(bytesToHex(result.pubKey!)).toBe(stakeVector.expectedPubKeyHex);
    expect(result.addressBytes).toBeInstanceOf(Uint8Array);
    expect(bytesToHex(result.addressBytes!)).toBe(stakeVector.addressHex);
  });

  it('returns ok=false for a tampered signature (flipped byte 0)', async () => {
    const tamperedSig = flipByte(stakeVector.signatureHex, 0);
    const result = await verifyCip8({
      signatureHex: tamperedSig,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false for a tampered signature (flipped last byte)', async () => {
    // The sig bytes are near the end of the COSE_Sign1; tamper the actual signature portion.
    // The signature is the last 64 bytes; COSE structure adds overhead so we target well into the hex.
    const tamperedSig = replaceLastByte(stakeVector.signatureHex);
    const result = await verifyCip8({
      signatureHex: tamperedSig,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when expectedPayload is wrong', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: 'dreptalk-login:wrong-nonce',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns ok=false when a different (wrong) COSE_Key is supplied', async () => {
    // Use the drep key for the stake key vector's signature.
    const wrongKey = drepVector ? drepVector.keyHex : stakeVector.keyHex.replace('3a7a', 'ffff');
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: wrongKey,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false for empty signatureHex (no throw)', async () => {
    const result = await verifyCip8({
      signatureHex: '',
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns ok=false for malformed signatureHex (no throw)', async () => {
    const result = await verifyCip8({
      signatureHex: 'deadbeef',
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns ok=false for non-hex signatureHex (no throw)', async () => {
    const result = await verifyCip8({
      signatureHex: 'not-hex!!!!',
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('verifyCip8 (drep-key-valid fixture)', () => {
  it('returns ok=true for a valid DRep key fixture', async () => {
    if (!drepVector) {
      // No DRep vector present; skip gracefully.
      return;
    }
    const result = await verifyCip8({
      signatureHex: drepVector.signatureHex,
      keyHex: drepVector.keyHex,
      expectedPayload: drepVector.payloadUtf8,
    });

    if (!result.ok) {
      throw new Error(`verifyCip8 drep failed: ${result.reason}`);
    }

    expect(result.ok).toBe(true);
    expect(result.pubKey).toBeInstanceOf(Uint8Array);
    expect(bytesToHex(result.pubKey!)).toBe(drepVector.expectedPubKeyHex);
  });
});
