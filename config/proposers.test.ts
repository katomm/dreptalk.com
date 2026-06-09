import { describe, it, expect } from 'vitest';
import { buildProposerIndex, getProposerByAddress, type Proposer } from './proposers.js';

const FIXTURE: Proposer[] = [
  { slug: 'intersect', name: 'Intersect', addresses: ['stake1ABC', 'stake1DEF'], icon: '/orgs/intersect.svg' },
  { slug: 'cf', name: 'Cardano Foundation', addresses: ['stake1XYZ'] },
];

describe('buildProposerIndex', () => {
  it('maps every address (normalized to lowercase) to its org', () => {
    const idx = buildProposerIndex(FIXTURE);
    expect(idx.get('stake1abc')!.slug).toBe('intersect');
    expect(idx.get('stake1def')!.slug).toBe('intersect'); // second address of the same org
    expect(idx.get('stake1xyz')!.name).toBe('Cardano Foundation');
    expect(idx.size).toBe(3);
  });
});

describe('getProposerByAddress', () => {
  it('returns null for null/empty/unknown input', () => {
    expect(getProposerByAddress(null)).toBeNull();
    expect(getProposerByAddress('')).toBeNull();
    expect(getProposerByAddress('stake1_not_in_registry_xxxxx')).toBeNull();
  });
});
