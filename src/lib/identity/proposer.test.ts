import { describe, it, expect } from 'vitest';
import { proposerView } from './proposer.js';
import type { Proposer } from '../../../config/proposers.js';

const known: Proposer = { slug: 'intersect', name: 'Intersect', addresses: ['stake1abc'], icon: '/orgs/intersect.svg', website: 'https://intersectmbo.org' };

describe('proposerView', () => {
  it('returns none for a missing address', () => {
    expect(proposerView(null).kind).toBe('none');
    expect(proposerView('').kind).toBe('none');
  });

  it('returns the known org (name, icon, website) when matched', () => {
    const v = proposerView('stake1abc', () => known);
    expect(v).toEqual({ kind: 'known', name: 'Intersect', icon: '/orgs/intersect.svg', website: 'https://intersectmbo.org' });
  });

  it('returns unknown with the seed and a truncated address when not matched', () => {
    const v = proposerView('stake1verylongrewardaddressxxxxxxxxxxxxxx', () => null);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') {
      expect(v.seed).toBe('stake1verylongrewardaddressxxxxxxxxxxxxxx');
      expect(v.short.endsWith('...')).toBe(true);
    }
  });
});
