import { describe, it, expect } from 'vitest';
import { buildProposerIndex, getProposerByAddress, PROPOSERS, type Proposer } from './proposers.js';

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

describe('the seeded registry', () => {
  it('resolves the confirmed proposer addresses to their org (guards against typos)', () => {
    expect(getProposerByAddress('stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp')?.slug).toBe('intersect');
    expect(getProposerByAddress('stake1uy7ucfwsxtv36lz2drg4nw538xswshmg9pw8h2yzqd4qrzgzhyrsg')?.slug).toBe('input-output');
    expect(getProposerByAddress('stake179vw36vvvkmq32dfa002gtc8mk6v4zv2a74ppaxsz3dejhs72dh4z')?.slug).toBe('pragma');
  });

  it('has no duplicate slugs and every org has at least one address', () => {
    const slugs = PROPOSERS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of PROPOSERS) expect(p.addresses.length).toBeGreaterThan(0);
  });
});
