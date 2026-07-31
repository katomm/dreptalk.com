// CIP-108 author-witness verification: the official interop vector proves
// layer 1 (raw pubkey, no address policy) accepts it, and layer 3 (wallet
// COSE_Key + strict reward-address policy) rejects it (mainnet enterprise).
// The production accept-path is proven with a genuine testnet-reward COSE
// built in-test (buildTestCose), not a hand-pinned fixture.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalBodyHashFor } from './cip108Canonical.js';
import { verifyGenericCip0008, verifyWalletAuthorWitness } from './authorWitness.js';
import { buildTestCose } from './__fixtures__/buildTestCose.js';

const vector = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/cip108-no-confidence.jsonld', import.meta.url)), 'utf8'),
);
const w = vector.authors[0].witness; // { witnessAlgorithm:'CIP-0008', publicKey: raw32hex, signature: coseSign1hex }

describe('layer 1: generic CIP-0008 over a raw key (official vector)', () => {
  it('verifies the official vector against its canonical body hash', async () => {
    const bodyHashHex = await canonicalBodyHashFor(vector.body);
    const res = await verifyGenericCip0008({ publicKeyHex: w.publicKey, signatureHex: w.signature, bodyHashHex });
    expect(res.ok).toBe(true);
  });

  it('rejects a tampered body hash', async () => {
    const res = await verifyGenericCip0008({ publicKeyHex: w.publicKey, signatureHex: w.signature, bodyHashHex: 'f'.repeat(64) });
    expect(res.ok).toBe(false);
  });
});

describe('layer 3: production wallet policy', () => {
  const bodyHash = 'a'.repeat(64);

  it('accepts a testnet reward-address COSE over the exact 32-byte body hash', async () => {
    const cose = await buildTestCose({ payloadHex: bodyHash, addrType: 'reward', networkId: 0, hashed: false });
    const res = await verifyWalletAuthorWitness({ keyHex: cose.coseKeyHex, signatureHex: cose.coseSign1Hex, bodyHashHex: bodyHash, expectedNetworkId: 0 });
    expect(res.ok).toBe(true);
  });

  it('rejects the official vector (mainnet enterprise address)', async () => {
    const bodyHashHex = await canonicalBodyHashFor(vector.body);
    // The vector has a raw key, not a COSE_Key, so the wallet-path decode fails OR the address policy rejects.
    const res = await verifyWalletAuthorWitness({ keyHex: w.publicKey, signatureHex: w.signature, bodyHashHex, expectedNetworkId: 0 });
    expect(res.ok).toBe(false);
  });

  it('rejects hashed=true', async () => {
    const cose = await buildTestCose({ payloadHex: bodyHash, addrType: 'reward', networkId: 0, hashed: true });
    const res = await verifyWalletAuthorWitness({ keyHex: cose.coseKeyHex, signatureHex: cose.coseSign1Hex, bodyHashHex: bodyHash, expectedNetworkId: 0 });
    expect(res.ok).toBe(false);
  });

  it('rejects a payment address', async () => {
    const cose = await buildTestCose({ payloadHex: bodyHash, addrType: 'enterprise', networkId: 0, hashed: false });
    const res = await verifyWalletAuthorWitness({ keyHex: cose.coseKeyHex, signatureHex: cose.coseSign1Hex, bodyHashHex: bodyHash, expectedNetworkId: 0 });
    expect(res.ok).toBe(false);
  });

  it('rejects a mainnet reward address', async () => {
    const cose = await buildTestCose({ payloadHex: bodyHash, addrType: 'reward', networkId: 1, hashed: false });
    const res = await verifyWalletAuthorWitness({ keyHex: cose.coseKeyHex, signatureHex: cose.coseSign1Hex, bodyHashHex: bodyHash, expectedNetworkId: 0 });
    expect(res.ok).toBe(false);
  });
});
