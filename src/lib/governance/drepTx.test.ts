// Unit tests for the pure construction helpers in drepTx.ts.
// buildRegisterDrepParts requires no network or wallet, so it runs offline.
// The full registerDRep function is covered by the preprod e2e suite (Phase B-11).

import { describe, it, expect } from 'vitest';
import { buildRegisterDrepParts } from './drepTx.js';

// Deterministic test fixtures.
const DREP_KEY_HASH = new Uint8Array(28).fill(0xab); // 28-byte blake2b-224 placeholder
const ANCHOR_URL = 'https://dreptalk.com/drep/0000000000000000000000000000000000000000000000000000000000000000.json';
// 64 hex chars = 32 bytes, a valid blake2b-256 placeholder.
const ANCHOR_HASH_HEX = 'ab'.repeat(32);

describe('buildRegisterDrepParts', () => {
  it('returns a Credential and Anchor without throwing', () => {
    const { drepCredential, anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    expect(drepCredential).toBeDefined();
    expect(anchor).toBeDefined();
  });

  it('constructs a KeyHash credential with the correct tag', () => {
    const { drepCredential } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    // Evolution SDK KeyHash has _tag "KeyHash".
    expect((drepCredential as { _tag: string })._tag).toBe('KeyHash');
  });

  it('round-trips the anchor URL via toJSON', () => {
    const { anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    // Anchor.toJSON returns { _tag, anchorUrl: string, anchorDataHash: hex }.
    const json = anchor.toJSON();
    expect(json.anchorUrl).toBe(ANCHOR_URL);
  });

  it('round-trips the anchor hash via toJSON', () => {
    const { anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    const json = anchor.toJSON();
    expect(json.anchorDataHash).toBe(ANCHOR_HASH_HEX);
  });

  it('throws on a hash that is too short (not 32 bytes)', () => {
    // hexToBytes('aa') = 1 byte, Anchor construction should reject a non-32-byte hash.
    expect(() =>
      buildRegisterDrepParts({
        drepKeyHash: DREP_KEY_HASH,
        anchorUrl: ANCHOR_URL,
        anchorHashHex: 'aa',
      }),
    ).toThrow();
  });
});
