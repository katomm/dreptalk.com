// CIP-108 author-witness verification: layer 3 (wallet COSE_Key + strict
// reward-address policy) rejects the official interop vector (mainnet
// enterprise address, raw key).
// The production accept-path is proven with a genuine testnet-reward COSE
// built in-test (buildTestCose), not a hand-pinned fixture.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalBodyHashFor } from './cip108Canonical.js';
import { verifyWalletAuthorWitness } from './authorWitness.js';
import { buildTestCose } from './__fixtures__/buildTestCose.js';

const vector = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/cip108-no-confidence.jsonld', import.meta.url)), 'utf8'),
);
const w = vector.authors[0].witness; // { witnessAlgorithm:'CIP-0008', publicKey: raw32hex, signature: coseSign1hex }

// The vector's real canonical body hash, so the rejection can only come from
// the key and address policy.
const vectorBodyHashHex = await canonicalBodyHashFor(vector.body);

describe('layer 3: production wallet policy', () => {
  const bodyHash = 'a'.repeat(64);

  it('accepts a testnet reward-address COSE over the exact 32-byte body hash', async () => {
    const cose = await buildTestCose({ payloadHex: bodyHash, addrType: 'reward', networkId: 0, hashed: false });
    const res = await verifyWalletAuthorWitness({ keyHex: cose.coseKeyHex, signatureHex: cose.coseSign1Hex, bodyHashHex: bodyHash, expectedNetworkId: 0 });
    expect(res.ok).toBe(true);
  });

  it('rejects the official vector (mainnet enterprise address)', async () => {
    // The vector has a raw key, not a COSE_Key, so the wallet-path decode fails OR the address policy rejects.
    const res = await verifyWalletAuthorWitness({ keyHex: w.publicKey, signatureHex: w.signature, bodyHashHex: vectorBodyHashHex, expectedNetworkId: 0 });
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
