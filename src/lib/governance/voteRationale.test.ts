import { describe, it, expect } from 'vitest';
import { buildVoteRationale, MAX_VOTE_RATIONALE } from './voteRationale.js';
import { blake2b256 } from '@/lib/crypto/blake.js';
import { bytesToHex } from '@/lib/crypto/hex.js';

describe('buildVoteRationale', () => {
  it('hash is blake2b-256 of the exact body bytes it serves (no reserialization)', () => {
    // Guards against a cgov-class mismatch on our own side: the hash we put
    // on-chain must be over the very bytes served at the anchor URL.
    const r = buildVoteRationale({ rationale: 'Weighing costs against ecosystem value “here”.' });
    const recomputed = bytesToHex(blake2b256(new TextEncoder().encode(r.body)));
    expect(r.hash).toBe(recomputed);
  });

  it('puts the rationale in body.comment and produces a stable hash', () => {
    const a = buildVoteRationale({ rationale: 'I support this because of X.' });
    const b = buildVoteRationale({ rationale: 'I support this because of X.' });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash); // deterministic
    const doc = JSON.parse(a.body);
    expect(doc.body.comment).toBe('I support this because of X.');
    expect(doc.hashAlgorithm).toBe('blake2b-256');
  });

  it('caps the rationale length', () => {
    const long = 'x'.repeat(MAX_VOTE_RATIONALE + 500);
    const r = buildVoteRationale({ rationale: long });
    expect(JSON.parse(r.body).body.comment.length).toBeLessThanOrEqual(MAX_VOTE_RATIONALE);
  });
});
