import { describe, it, expect } from 'vitest';
import { proposerView } from './proposer.js';
import type { Proposer } from '../../../config/proposers.js';
import { getProposers } from '../../../config/proposers.js';

const known: Proposer = { slug: 'intersect', name: 'Intersect', addresses: ['stake1abc'], icon: '/orgs/intersect.svg', website: 'https://intersectmbo.org' };

describe('proposerView', () => {
  it('returns none for a missing address', () => {
    expect(proposerView(null).kind).toBe('none');
    expect(proposerView('').kind).toBe('none');
  });

  it('returns the known org (name, icon, website) when matched', () => {
    const v = proposerView('stake1abc', null, () => known);
    expect(v).toEqual({ kind: 'known', name: 'Intersect', icon: '/orgs/intersect.svg', website: 'https://intersectmbo.org' });
  });

  it('returns unknown with the seed and a truncated address when not matched', () => {
    const v = proposerView('stake1verylongrewardaddressxxxxxxxxxxxxxx', null, () => null);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') {
      expect(v.seed).toBe('stake1verylongrewardaddressxxxxxxxxxxxxxx');
      expect(v.short.endsWith('...')).toBe(true);
    }
  });
});

describe('proposerView with declared authors', () => {
  it('prefers the registry over a declared name', () => {
    const v = proposerView('stake1abc', ['Someone Else'], () => known);
    expect(v).toEqual({ kind: 'known', name: 'Intersect', icon: '/orgs/intersect.svg', website: 'https://intersectmbo.org' });
  });

  it('uses the first declared name and counts the rest when the address is unknown', () => {
    const v = proposerView('stake1zzz', ['Cardano Japan Council', 'Tingvard', 'Ace Alliance'], () => null);
    expect(v).toEqual({ kind: 'declared', name: 'Cardano Japan Council', extra: 2, seed: 'stake1zzz' });
  });

  it('reports extra 0 for a single declared name', () => {
    const v = proposerView('stake1zzz', ['Mike Hornan'], () => null);
    expect(v.kind).toBe('declared');
    if (v.kind === 'declared') expect(v.extra).toBe(0);
  });

  it('falls back to the address when there are no declared names', () => {
    expect(proposerView('stake1zzz', null, () => null).kind).toBe('unknown');
    expect(proposerView('stake1zzz', [], () => null).kind).toBe('unknown');
  });

  it('discards a declared name that impersonates a registry organisation', () => {
    const registry = () => [known];
    expect(proposerView('stake1zzz', ['Intersect'], () => null, registry).kind).toBe('unknown');
    expect(proposerView('stake1zzz', ['  intersect  '], () => null, registry).kind).toBe('unknown');
    expect(proposerView('stake1zzz', ['INTER  SECT'], () => null, registry).kind).toBe('declared');
  });

  it('discards the whole array when any entry collides', () => {
    const registry = () => [known];
    const v = proposerView('stake1zzz', ['Honest Group', 'Intersect'], () => null, registry);
    expect(v.kind).toBe('unknown');
  });

  it('guards against every name in the real registry', () => {
    for (const p of getProposers()) {
      expect(proposerView('stake1zzz', [p.name], () => null).kind).toBe('unknown');
    }
  });
});
