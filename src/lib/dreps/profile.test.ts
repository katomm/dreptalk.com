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

describe('drepProfileSummary', () => {
  const base = {
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
  };

  it('composes a full summary from on-chain facts', () => {
    const s = drepProfileSummary(base);
    expect(s).toContain('Alice is an active Cardano DRep, registered in epoch 507.');
    expect(s).toContain('They hold 2.5M ₳ of delegated voting power, about 0.42% of the active stake.');
    expect(s).toContain('has cast 47 on-chain governance votes (30 yes, 10 no, 7 abstain).');
    expect(s).toContain('taken part in 53 of 60 decided actions (88%).');
    expect(s).toContain('published 31 rationales');
    expect(s).toContain('4 forum posts');
  });

  it('handles a brand-new DRep with no votes, power, or posts', () => {
    const s = drepProfileSummary({
      ...base,
      votingPowerFormatted: null,
      influencePct: null,
      votesCast: 0,
      withRationale: 0,
      participation: null,
      forumPosts: 0,
      registeredEpoch: null,
    });
    expect(s).toBe('Alice is an active Cardano DRep. Alice has no recorded on-chain governance votes yet.');
  });

  it('marks a retired DRep and drops the voting-power clause', () => {
    const s = drepProfileSummary({ ...base, retired: true, active: false });
    expect(s).toContain('Alice is a retired Cardano DRep');
    expect(s).toContain('deregistered on-chain and no longer holds voting power');
    expect(s).not.toContain('delegated voting power');
  });

  it('singularises a single vote, rationale, and post', () => {
    const s = drepProfileSummary({
      ...base,
      votesCast: 1,
      breakdown: { yes: 1, no: 0, abstain: 0 },
      withRationale: 1,
      participation: null,
      forumPosts: 1,
    });
    expect(s).toContain('1 on-chain governance vote (');
    expect(s).toContain('published 1 rationale explaining');
    expect(s).toContain('1 forum post on DRepTalk');
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
