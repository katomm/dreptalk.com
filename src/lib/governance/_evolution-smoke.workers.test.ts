// SPIKE smoke test: does EvolutionSDK (@evolution-sdk/evolution) load and run
// inside the Cloudflare Workers runtime (workerd, via the vitest workers pool)?
// The sibling sites prove it on CF Pages; DRepTalk is on CF Workers, so we
// confirm here. This builds and serializes the exact Conway governance
// certificates we need (reg_drep / unreg_drep) with no network, so it isolates
// "the SDK runs on workerd" from "Koios is reachable".
import { describe, it, expect } from 'vitest';
import { Certificate, Credential } from '@evolution-sdk/evolution';

describe('EvolutionSDK governance certs on workerd (smoke)', () => {
  it('builds and serializes a reg_drep certificate, round-trips it', () => {
    const drepKeyHash = new Uint8Array(28).fill(0xab); // 28-byte blake2b-224 credential
    const cred = Credential.makeKeyHash(drepKeyHash);

    const regCert = new Certificate.RegDrepCert({
      drepCredential: cred,
      coin: 500_000_000n, // deposit; comes from protocol params in real use
      anchor: null, // CIP-119 anchor optional; null is valid per CDDL
    });

    const hex = Certificate.toCBORHex(regCert);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Certificate.fromCBORHex(hex)._tag).toBe('RegDrepCert');
  });

  it('builds and serializes an unreg_drep (retire) certificate', () => {
    const cred = Credential.makeKeyHash(new Uint8Array(28).fill(0xcd));
    const unregCert = new Certificate.UnregDrepCert({
      drepCredential: cred,
      coin: 500_000_000n, // refunded deposit
    });

    const hex = Certificate.toCBORHex(unregCert);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Certificate.fromCBORHex(hex)._tag).toBe('UnregDrepCert');
  });
});
