import { describe, it, expect } from 'vitest';
import { isIndexableProfile, influencePct, formatSharePct, drepMetaDescription, drepProfileSummary } from './profile.js';

describe('isIndexableProfile (SEO quality-gate)', () => {
  it('is indexable with on-chain metadata', () => {
    expect(isIndexableProfile({ hasMetadata: true, postCount: 0 })).toBe(true);
  });
  it('is indexable with forum activity', () => {
    expect(isIndexableProfile({ hasMetadata: false, postCount: 3 })).toBe(true);
  });
  it('is NOT indexable when thin: a recorded vote alone does not qualify', () => {
    // A nameless vote-only profile is thin/near-duplicate and never ranks, so it
    // stays noindex and out of the sitemap.
    expect(isIndexableProfile({ hasMetadata: false, postCount: 0 })).toBe(false);
  });
});

describe('drepMetaDescription', () => {
  it('is built from on-chain facts, not the bio', () => {
    const d = drepMetaDescription({ displayName: 'Yoroi Wallet', votingPowerFormatted: '2.5M ₳', votesCast: 47 });
    expect(d).toContain('Yoroi Wallet');
    expect(d).toContain('2.5M ₳');
    expect(d).toContain('47 recorded on-chain votes');
  });
});

describe('drepProfileSummary', () => {
  it('composes a summary from on-chain facts', () => {
    const s = drepProfileSummary({
      displayName: 'Alice',
      active: true,
      retired: false,
      registeredEpoch: 507,
      votingPowerFormatted: '2.5M ₳',
      influencePct: 0.42,
      votesCast: 47,
      breakdown: { yes: 30, no: 10, abstain: 7 },
      withRationale: 31,
      participation: { eligible: 60, voted: 53 },
      forumPosts: 4,
    });
    expect(s).toContain('Alice');
    expect(s).toContain('epoch 507');
    expect(s).toContain('2.5M ₳');
    expect(s).toContain('53 of 60 decided actions (88%)');
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

describe('formatSharePct', () => {
  it('renders two decimals for a normal share', () => {
    expect(formatSharePct(0.42)).toBe('0.42%');
    expect(formatSharePct(12.3456)).toBe('12.35%');
  });
  it('never shows a broken 0.00% for a tiny-but-real share', () => {
    expect(formatSharePct(0.004)).toBe('<0.01%');
    expect(formatSharePct(0.0000001)).toBe('<0.01%');
    expect(formatSharePct(0.005)).toBe('0.01%');
  });
  it('is null for null or non-positive input', () => {
    expect(formatSharePct(null)).toBeNull();
    expect(formatSharePct(0)).toBeNull();
  });
});
