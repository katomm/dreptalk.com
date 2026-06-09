import { describe, it, expect } from 'vitest';
import { isIndexableProfile, influencePct } from './profile.js';

describe('isIndexableProfile (SEO quality-gate)', () => {
  it('is indexable with on-chain metadata', () => {
    expect(isIndexableProfile({ hasMetadata: true, postCount: 0, votesCast: 0 })).toBe(true);
  });
  it('is indexable with forum activity or votes', () => {
    expect(isIndexableProfile({ hasMetadata: false, postCount: 3, votesCast: 0 })).toBe(true);
    expect(isIndexableProfile({ hasMetadata: false, postCount: 0, votesCast: 5 })).toBe(true);
  });
  it('is NOT indexable when thin', () => {
    expect(isIndexableProfile({ hasMetadata: false, postCount: 0, votesCast: 0 })).toBe(false);
  });
});

describe('influencePct', () => {
  it('is the share of total active power, in percent', () => {
    expect(influencePct('25', 100)).toBeCloseTo(25);
  });
  it('is null without power or total', () => {
    expect(influencePct(null, 100)).toBeNull();
    expect(influencePct('5', 0)).toBeNull();
  });
});
