// Proves canonicalBodyHashFor (and its jsonld/URDNA2015 dependency) runs on workerd.
import { describe, it, expect } from 'vitest';
import { canonicalBodyHashFor } from './cip108Canonical.js';

describe('canonicalBodyHashFor on workerd', () => {
  it('canonicalizes with the real context and is title-sensitive', async () => {
    const body = { title: 'T', abstract: 'A', motivation: 'M', rationale: 'R' };
    const h = await canonicalBodyHashFor(body);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(await canonicalBodyHashFor({ ...body, title: 'T2' }));
  });
});
