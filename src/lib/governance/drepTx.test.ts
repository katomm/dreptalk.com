// Unit tests for the pure construction helpers in drepTx.ts.
// buildRegisterDrepParts requires no network or wallet, so it runs offline.
// The full registerDRep function is covered by the preprod e2e suite (Phase B-11).

import { describe, it, expect } from 'vitest';
import { buildRegisterDrepParts, queueRegisterDrepOps, queueDeregisterDrepOps } from './drepTx.js';
import { bytesToHex } from '../crypto/hex.js';

// Deterministic test fixtures.
const DREP_KEY_HASH = new Uint8Array(28).fill(0xab); // 28-byte blake2b-224 placeholder
const ANCHOR_URL = 'https://dreptalk.com/drep/0000000000000000000000000000000000000000000000000000000000000000.json';
// 64 hex chars = 32 bytes, a valid blake2b-256 placeholder.
const ANCHOR_HASH_HEX = 'ab'.repeat(32);

// Records the ops queued onto a tx builder so we can assert the chain without a
// live wallet/provider. Each op returns the recorder so the chain is fluent.
function makeBuilderRecorder() {
  const calls: Array<{ op: string; arg: unknown }> = [];
  const rec = {
    registerDRep(arg: unknown) { calls.push({ op: 'registerDRep', arg }); return rec; },
    deregisterDRep(arg: unknown) { calls.push({ op: 'deregisterDRep', arg }); return rec; },
    addSigner(arg: unknown) { calls.push({ op: 'addSigner', arg }); return rec; },
    attachMetadata(arg: unknown) { calls.push({ op: 'attachMetadata', arg }); return rec; },
  };
  return { rec, calls };
}

function addSignerKeyHashHex(calls: Array<{ op: string; arg: unknown }>): string | null {
  const c = calls.find((x) => x.op === 'addSigner');
  if (!c) return null;
  const keyHash = (c.arg as { keyHash: { hash: Uint8Array } }).keyHash.hash;
  return bytesToHex(keyHash);
}

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

// Regression guard for the "Insufficient fee" bug: the reg_drep / unreg_drep
// certificate is witnessed by the DRep key (which controls no input), and
// EvolutionSDK only sizes the fee for declared signers. So our build chain MUST
// declare the DRep key via addSigner, or the fee falls one vkey witness short.
// These assert exactly that on the shared chains production uses. The real fee
// arithmetic against live preprod params is covered by the gated live e2e.
describe('queueRegisterDrepOps (fee: DRep key required signer)', () => {
  it('declares the DRep key as a required signer and queues the reg_drep cert', () => {
    const { drepCredential, anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });
    const { rec, calls } = makeBuilderRecorder();

    queueRegisterDrepOps(rec as Parameters<typeof queueRegisterDrepOps>[0], {
      drepCredential,
      anchor,
      drepKeyHash: DREP_KEY_HASH,
    });

    expect(calls.some((c) => c.op === 'registerDRep')).toBe(true);
    expect(addSignerKeyHashHex(calls)).toBe(bytesToHex(DREP_KEY_HASH));
  });
});

describe('queueDeregisterDrepOps (fee: DRep key required signer)', () => {
  it('declares the DRep key as a required signer and queues the unreg_drep cert', () => {
    const { drepCredential } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });
    const { rec, calls } = makeBuilderRecorder();

    queueDeregisterDrepOps(rec as Parameters<typeof queueDeregisterDrepOps>[0], {
      drepCredential,
      drepKeyHash: DREP_KEY_HASH,
    });

    expect(calls.some((c) => c.op === 'deregisterDRep')).toBe(true);
    expect(addSignerKeyHashHex(calls)).toBe(bytesToHex(DREP_KEY_HASH));
  });
});
