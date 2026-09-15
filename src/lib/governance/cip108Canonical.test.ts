// Interop test: CIP-108 URDNA2015 canonical body hashing against the official vector.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalBodyHashFor, CIP108_CONTEXT } from './cip108Canonical.js';

const vector = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/cip108-no-confidence.jsonld', import.meta.url)), 'utf8'),
);

describe('canonicalBodyHashFor', () => {
  it('matches the official CIP-108 no-confidence vector', async () => {
    const hash = await canonicalBodyHashFor(vector.body);
    expect(hash).toBe('4a7ecc544559df67ece3f7f90f76c4e3e7e329a274c79a06dcfbf28351db600e');
  });

  it('uses a context identical to the official example', () => {
    // Guards against drift: our inlined constant must equal the vector's @context.
    expect(CIP108_CONTEXT).toEqual(vector['@context']);
  });

  it('is deterministic and title-sensitive', async () => {
    const body = { title: 'T', abstract: 'A', motivation: 'M', rationale: 'R' };
    expect(await canonicalBodyHashFor(body)).toBe(await canonicalBodyHashFor({ ...body }));
    expect(await canonicalBodyHashFor(body)).not.toBe(await canonicalBodyHashFor({ ...body, title: 'T2' }));
  });
});
