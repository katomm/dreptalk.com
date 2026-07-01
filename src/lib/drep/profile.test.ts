import { describe, it, expect } from 'vitest';
import { isIndexableProfile, influencePct, drepMetaDescription } from './profile.js';

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

describe('drepMetaDescription', () => {
  it('is built from on-chain facts, not the bio', () => {
    const d = drepMetaDescription({ displayName: 'Yoroi Wallet', votingPowerFormatted: '2.5M ₳', votesCast: 47 });
    expect(d).toBe(
      'Yoroi Wallet: Cardano DRep with 2.5M ₳ voting power and 47 recorded on-chain votes. See the full voting record, rationales, and delegation on DRepTalk.',
    );
  });
  it('singularises a single vote and handles none', () => {
    expect(drepMetaDescription({ displayName: 'A', votingPowerFormatted: '1 ₳', votesCast: 1 })).toContain(
      '1 recorded on-chain vote.',
    );
    expect(drepMetaDescription({ displayName: 'A', votingPowerFormatted: '0 ₳', votesCast: 0 })).toContain(
      'no recorded on-chain votes yet.',
    );
  });
  it('marks retired DReps', () => {
    expect(
      drepMetaDescription({ displayName: 'A', votingPowerFormatted: '0 ₳', votesCast: 0, retired: true }),
    ).toContain('Retired Cardano DRep');
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
