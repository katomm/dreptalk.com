import { describe, expect, it } from 'vitest';
import { discussionCardModel, drepCardModel, type GovCardInput, govCardModel } from './model.js';
import { accentForType, BRAND_ACCENT } from './theme.js';

const baseAction: GovCardInput = {
  type: 'TreasuryWithdrawals',
  status: 'active',
  title: 'Fund the Cardano Summit 2026',
  abstract: 'Funds the 2026 community summit and regional meetups across the ecosystem.',
  expiryEpoch: 294,
  drepYesPct: 62,
  drepNoPct: 9,
  drepYes: 40,
  drepNo: 6,
  drepAbstain: 20,
  spoYesPct: null,
  spoNoPct: null,
  spoYes: null,
  spoNo: null,
  spoAbstain: null,
};

describe('govCardModel', () => {
  it('maps type to accent, label, status and tally', () => {
    const m = govCardModel(baseAction, { expiryUnixMs: null, now: 0, proposerName: 'Intersect' });
    expect(m.accent).toBe(accentForType('TreasuryWithdrawals'));
    expect(m.typeLabel).toBe('Treasury Withdrawals');
    expect(m.status.label).toBe('Active');
    expect(m.tally).toEqual({ yes: 62, no: 9, abstain: 29, role: 'DRep' });
  });

  it('shows the proposer in the meta line only when supplied', () => {
    const withProposer = govCardModel(baseAction, { expiryUnixMs: null, now: 0, proposerName: 'Intersect' });
    expect(withProposer.meta).toContain('by Intersect');
    const without = govCardModel(baseAction, { expiryUnixMs: null, now: 0 });
    expect(without.meta).not.toContain('by');
  });

  it('falls back to the readable type when the title is empty', () => {
    const m = govCardModel({ ...baseAction, title: null }, { expiryUnixMs: null, now: 0 });
    expect(m.title).toBe('Treasury Withdrawals');
  });

  it('exposes the abstract as the subtitle, or null when absent', () => {
    const withAbstract = govCardModel(baseAction, { expiryUnixMs: null, now: 0 });
    expect(withAbstract.subtitle).toContain('community summit');
    const without = govCardModel({ ...baseAction, abstract: null }, { expiryUnixMs: null, now: 0 });
    expect(without.subtitle).toBeNull();
  });

  it('returns no tally when nothing has synced', () => {
    const m = govCardModel(
      { ...baseAction, drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null },
      { expiryUnixMs: null, now: 0 },
    );
    expect(m.tally).toBeNull();
  });
});

describe('drepCardModel', () => {
  const drep = {
    drepId: 'drep1abcdefghijklmnopqrstuvwxyz0123456789longtail',
    name: 'Lido Nation',
    bio: '<p>Community builder & governance advocate.</p>',
    votingPower: 12_400_000_000_000,
    active: true,
    status: 'registered',
    registeredEpoch: 432,
  };

  it('builds name, id sub-line, bio and four stats', () => {
    const m = drepCardModel(drep, {
      avatarDataUrl: 'data:image/svg+xml;base64,xx',
      influencePct: 0.83,
      votesCast: 47,
      participation: { eligible: 50, voted: 40 },
    });
    expect(m.accent).toBe(BRAND_ACCENT);
    expect(m.name).toBe('Lido Nation');
    expect(m.idShort).toContain('...');
    expect(m.bio).toBe('Community builder & governance advocate.');
    expect(m.stats).toHaveLength(4);
    expect(m.stats[0].value).toBe('12.4M ₳');
    expect(m.stats[0].label).toBe('voting power (0.83%)');
    expect(m.stats[1]).toEqual({ value: '47', label: 'votes cast', icon: 'votes' });
    expect(m.stats[2]).toEqual({ value: '80%', label: 'participation', icon: 'participation' });
    expect(m.stats[3]).toEqual({ value: 'Epoch 432', label: 'Active DRep', icon: 'epoch' });
    expect(m.stats.map((s) => s.icon)).toEqual(['power', 'votes', 'participation', 'epoch']);
  });

  it('uses the truncated id as the name and drops the sub-line when unnamed', () => {
    const m = drepCardModel(
      { ...drep, name: null, bio: null },
      { avatarDataUrl: 'x', influencePct: null, votesCast: 0, participation: null },
    );
    expect(m.idShort).toBeNull();
    expect(m.name).toContain('...');
    expect(m.bio).toBeNull();
    expect(m.stats).toHaveLength(3);
    expect(m.stats[0].label).toBe('voting power');
  });
});

describe('discussionCardModel', () => {
  const topic = {
    title: 'How should we fund tooling?',
    categorySlug: 'general',
    postCount: 43,
    openingPostHtml: '<p>Curious what the community thinks about a dedicated tooling fund.</p>',
  };

  it('humanizes the category, counts replies, carries the author and opening-post subtitle', () => {
    const m = discussionCardModel(topic, { authorName: 'Ada Hernandez', avatarDataUrl: 'data:x' });
    expect(m.category).toBe('General and Off-topic');
    expect(m.title).toBe('How should we fund tooling?');
    expect(m.authorName).toBe('Ada Hernandez');
    expect(m.meta).toBe('42 replies');
    expect(m.subtitle).toContain('dedicated tooling fund');
  });

  it('resolves the registry name, singularizes one reply, and has no subtitle without a post', () => {
    const m = discussionCardModel(
      { title: 'Hi', categorySlug: 'governance-actions', postCount: 2, openingPostHtml: null },
      { authorName: null, avatarDataUrl: null },
    );
    expect(m.category).toBe('Governance Actions');
    expect(m.meta).toBe('1 reply');
    expect(m.authorName).toBeNull();
    expect(m.subtitle).toBeNull();
  });

  it('falls back to Discussion for an unknown category', () => {
    const m = discussionCardModel(
      { title: 'Hi', categorySlug: 'does-not-exist', postCount: 1, openingPostHtml: null },
      { authorName: null, avatarDataUrl: null },
    );
    expect(m.category).toBe('Discussion');
  });

  it('shows zero replies for a topic with only the opening post', () => {
    const m = discussionCardModel({ ...topic, postCount: 1 }, { authorName: null, avatarDataUrl: null });
    expect(m.meta).toBe('0 replies');
  });
});
