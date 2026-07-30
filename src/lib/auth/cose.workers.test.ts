// CIP-8 COSE_Sign1 verifier tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// This exercises WebCrypto Ed25519 in the Workers runtime, with @noble/curves as fallback.
import { describe, it, expect } from 'vitest';
import { decode, encode } from 'cborg';
import vectors from './__fixtures__/cip8-vectors.json';
import { makeCoseSignature, type6Address } from './__fixtures__/makeCose.js';
import { verifyCip8 } from './cose.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';

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
  return `${hex.slice(0, -2)}ff`;
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

describe('verifyCip8 (real DRep signatures, as a CIP-95 wallet produces)', () => {
  const PAYLOAD = 'dreptalk:dreptalk.com:real-drep-nonce:1700000000';
  const SEED = new Uint8Array(32).fill(7);

  it('accepts a CIP-19 type-6 enterprise address (preprod header 0x60)', async () => {
    const keyHash = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: new Uint8Array(28) }).keyHash;
    const cose = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: type6Address(keyHash, 'preprod') });
    const result = await verifyCip8({ signatureHex: cose.signatureHex, keyHex: cose.keyHex, expectedPayload: PAYLOAD });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect(result.addressBytes![0]).toBe(0x60);
    expect(bytesToHex(result.pubKey!)).toBe(bytesToHex(cose.pubKey));
  });

  it('accepts a CIP-19 type-6 enterprise address (mainnet header 0x61)', async () => {
    const keyHash = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: new Uint8Array(28) }).keyHash;
    const cose = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: type6Address(keyHash, 'mainnet') });
    const result = await verifyCip8({ signatureHex: cose.signatureHex, keyHex: cose.keyHex, expectedPayload: PAYLOAD });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect(result.addressBytes![0]).toBe(0x61);
  });

  it('accepts a bare 28-byte DRep key hash (no header byte)', async () => {
    const keyHash = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: new Uint8Array(28) }).keyHash;
    const cose = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: keyHash });
    const result = await verifyCip8({ signatureHex: cose.signatureHex, keyHex: cose.keyHex, expectedPayload: PAYLOAD });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect(result.addressBytes!.length).toBe(28);
  });

  it('rejects when the address key hash does not match the signing key', async () => {
    const cose = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: type6Address(new Uint8Array(28).fill(0xaa), 'preprod') });
    const result = await verifyCip8({ signatureHex: cose.signatureHex, keyHex: cose.keyHex, expectedPayload: PAYLOAD });
    expect(result.ok).toBe(false);
  });
});

describe('verifyCip8 (hashed payload, as hardware wallets sign)', () => {
  const PAYLOAD = 'dreptalk:dreptalk.com:hashed-nonce:1700000000';
  const SEED = new Uint8Array(32).fill(9);

  it('accepts hashed=true with a Blake2b-224 payload digest (Ledger-style)', async () => {
    const keyHash = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: new Uint8Array(28) }).keyHash;
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: type6Address(keyHash, 'preprod'),
      payloadHash: 'blake2b224',
    });
    const result = await verifyCip8({ signatureHex: cose.signatureHex, keyHex: cose.keyHex, expectedPayload: PAYLOAD });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect(bytesToHex(result.pubKey!)).toBe(bytesToHex(cose.pubKey));
  });

  it('accepts hashed=true with a Blake2b-256 payload digest', async () => {
    const keyHash = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: new Uint8Array(28) }).keyHash;
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: type6Address(keyHash, 'preprod'),
      payloadHash: 'blake2b256',
    });
    const result = await verifyCip8({ signatureHex: cose.signatureHex, keyHex: cose.keyHex, expectedPayload: PAYLOAD });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect(bytesToHex(result.pubKey!)).toBe(bytesToHex(cose.pubKey));
  });

  it('rejects hashed=true when the digest is of a different payload', async () => {
    const keyHash = makeCoseSignature({ seed: SEED, payload: PAYLOAD, addressBytes: new Uint8Array(28) }).keyHash;
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: type6Address(keyHash, 'preprod'),
      payloadHash: 'blake2b224',
    });
    const result = await verifyCip8({
      signatureHex: cose.signatureHex,
      keyHex: cose.keyHex,
      expectedPayload: 'dreptalk:dreptalk.com:other-nonce:1700000001',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('hashed payload');
  });
});

// Helpers for mutating COSE_Key / COSE_Sign1 via cborg round-trip.

/** Re-encodes a COSE_Key map with one integer key set to a new value. */
function mutateCoseKey(keyHex: string, mapKey: number, newValue: number | Uint8Array): string {
  const keyMap: Map<number, unknown> = decode(hexToBytes(keyHex), { useMaps: true }) as Map<number, unknown>;
  keyMap.set(mapKey, newValue);
  return bytesToHex(encode(keyMap));
}

/** Re-encodes a COSE_Sign1 with the protected header map key 1 (alg) changed to newAlg. */
function mutateCoseSign1ProtectedAlg(sigHex: string, newAlg: number): string {
  const coseSign1: [Uint8Array, unknown, Uint8Array, Uint8Array] = decode(
    hexToBytes(sigHex),
    { useMaps: true },
  ) as [Uint8Array, unknown, Uint8Array, Uint8Array];
  const [protectedBstr, unprotectedHeader, payload, sig] = coseSign1;
  const protectedMap: Map<number, unknown> = decode(protectedBstr, { useMaps: true }) as Map<number, unknown>;
  protectedMap.set(1, newAlg);
  const newProtectedBstr = encode(protectedMap);
  return bytesToHex(encode([newProtectedBstr, unprotectedHeader, payload, sig]));
}

/** Re-encodes a COSE_Sign1 with the sigBstr (index 3) replaced by a new value. */
function mutateCoseSign1Sig(sigHex: string, newSig: Uint8Array): string {
  const coseSign1: [Uint8Array, unknown, Uint8Array, Uint8Array] = decode(
    hexToBytes(sigHex),
    { useMaps: true },
  ) as [Uint8Array, unknown, Uint8Array, Uint8Array];
  const [protectedBstr, unprotectedHeader, payload] = coseSign1;
  return bytesToHex(encode([protectedBstr, unprotectedHeader, payload, newSig]));
}

describe('verifyCip8 negative guard cases (alg, kty, crv, key size, sig)', () => {
  // Each case mutates exactly one field of the valid stake-key-valid fixture.
  // The guards run before signature math, so these prove the guard, not the crypto.

  it('rejects COSE_Key with alg changed from -8 to -7 (ok=false, no throw)', async () => {
    const mutatedKeyHex = mutateCoseKey(stakeVector.keyHex, 3, -7);
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Key with kty changed from 1 to 2 (ok=false, no throw)', async () => {
    const mutatedKeyHex = mutateCoseKey(stakeVector.keyHex, 1, 2);
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Key with crv changed from 6 to 1 (ok=false, no throw)', async () => {
    const mutatedKeyHex = mutateCoseKey(stakeVector.keyHex, -1, 1);
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Key with x truncated to 31 bytes (ok=false, no throw)', async () => {
    // Decode original key, slice 1 byte off x, re-encode.
    const keyMap: Map<number, unknown> = decode(hexToBytes(stakeVector.keyHex), { useMaps: true }) as Map<number, unknown>;
    const xFull = keyMap.get(-2) as Uint8Array;
    keyMap.set(-2, xFull.slice(0, 31));
    const mutatedKeyHex = bytesToHex(encode(keyMap));
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Sign1 with protected header alg changed from -8 to -7 (ok=false, no throw)', async () => {
    const mutatedSigHex = mutateCoseSign1ProtectedAlg(stakeVector.signatureHex, -7);
    const result = await verifyCip8({
      signatureHex: mutatedSigHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Sign1 with sigBstr replaced by empty Uint8Array (ok=false, no throw)', async () => {
    const mutatedSigHex = mutateCoseSign1Sig(stakeVector.signatureHex, new Uint8Array(0));
    const result = await verifyCip8({
      signatureHex: mutatedSigHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });
});
