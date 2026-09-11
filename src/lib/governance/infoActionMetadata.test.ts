import { describe, it, expect } from 'vitest';
import { buildInfoActionMetadata } from './infoActionMetadata.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import type { Cip108Reference } from './cip108Canonical.js';

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

  it('omits the references key when absent, and an explicit empty array hashes the same as absent', () => {
    const absent = buildInfoActionMetadata({ body, authors: [] });
    const emptyArray = buildInfoActionMetadata({ body: { ...body, references: [] }, authors: [] });
    expect(emptyArray.hash).toBe(absent.hash);
    expect(emptyArray.body).toBe(absent.body);
    const doc = JSON.parse(absent.body);
    expect(Object.keys(doc.body)).toEqual(['title', 'abstract', 'motivation', 'rationale']);
  });

  it('includes references as the last body field, with fixed per-entry key order, when present', () => {
    const references: Cip108Reference[] = [
      { '@type': 'Other', label: 'Forum thread', uri: 'https://example.com/thread' },
      { '@type': 'Other', label: 'Docs', uri: 'https://example.com/docs' },
    ];
    const { body: served, hash } = buildInfoActionMetadata({ body: { ...body, references }, authors: [] });
    const doc = JSON.parse(served);
    expect(Object.keys(doc.body)).toEqual(['title', 'abstract', 'motivation', 'rationale', 'references']);
    expect(doc.body.references).toEqual(references);
    // Fixed per-entry key order in the raw served bytes (JSON.stringify preserves insertion order).
    expect(served).toContain('"references":[{"@type":"Other","label":"Forum thread","uri":"https://example.com/thread"}');
    expect(hash).toBe(bytesToHex(blake2b256(new TextEncoder().encode(served))));
  });
});
