import { describe, it, expect } from 'vitest';
import { buildInfoActionMetadata } from './infoActionMetadata.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

const body = { title: 'Ping', abstract: 'A', motivation: 'M', rationale: 'R' };

describe('buildInfoActionMetadata', () => {
  it('produces a stable hash equal to blake2b-256 of the served bytes', () => {
    const a = buildInfoActionMetadata({ body, authors: [] });
    const b = buildInfoActionMetadata({ body, authors: [] });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(bytesToHex(blake2b256(new TextEncoder().encode(a.body))));
    const doc = JSON.parse(a.body);
    expect(doc.hashAlgorithm).toBe('blake2b-256');
    expect(doc.authors).toEqual([]);
    expect(doc.body).toEqual(body);
    expect(doc['@context']).toBeDefined();
  });

  it('embeds a witnessed author verbatim', () => {
    const authors = [{ name: 'Alice', witness: { witnessAlgorithm: 'CIP-0008' as const, publicKey: 'aa', signature: 'bb' } }];
    const doc = JSON.parse(buildInfoActionMetadata({ body, authors }).body);
    expect(doc.authors[0].name).toBe('Alice');
    expect(doc.authors[0].witness.witnessAlgorithm).toBe('CIP-0008');
  });
});
