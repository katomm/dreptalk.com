import { describe, expect, it } from 'vitest';
import {
  analyticsCardModel,
  discussionCardModel,
  drepCardModel,
  type GovCardInput,
  govCardModel,
  helpCardModel,
  type MoverInput,
  moversCardModel,
  voteCardModel,
} from './model.js';
import { analyticsCardHtml, moversCardHtml } from './templates.js';
import { accentForType, BRAND_ACCENT, TALLY } from './theme.js';

const baseAction: GovCardInput = {
  type: 'TreasuryWithdrawals',
  status: 'active',
  title: 'Fund the Cardano Summit 2026',
  abstract: 'Funds the 2026 community summit and regional meetups across the ecosystem.',
  expiryEpoch: 294,
  drepYesPct: 62,
  drepNoPct: 9,
  spoYesPct: null,
  spoNoPct: null,
  ccYesPct: null,
  ccNoPct: null,
  drepYes: 40,
  drepNo: 6,
  drepAbstain: 20,
  spoYes: null,
  spoNo: null,
  spoAbstain: null,
  ccYes: null,
  ccNo: null,
  ccAbstain: null,
  drepYesPower: null,
  drepNoPower: null,
  drepAbstainPower: null,
  spoYesPower: null,
  spoNoPower: null,
  spoAbstainPower: null,
  drepVotedPower: null,
  spoEligiblePower: null,
  drepNoSidePower: null,
  spoNoSidePower: null,
  drepAlwaysAbstainPower: null,
  drepAlwaysNoConfidencePower: null,
  spoAlwaysAbstainPower: null,
  spoAlwaysNoConfidencePower: null,
};

describe('govCardModel', () => {
  it('maps type to accent, label, status and tally', () => {
    const m = govCardModel(baseAction, { expiryUnixMs: null, now: 0, proposerName: 'Intersect' });
    expect(m.accent).toBe(accentForType('TreasuryWithdrawals'));
    expect(m.typeLabel).toBe('Treasury Withdrawals');
    expect(m.status.label).toBe('Active');
    // Number-led headline: the leading body's Yes-of-eligible share (drepYesPct 62),
    // denominator-independent, so non-voting stake is never shown as No (see
    // headlineComposition).
    expect(m.tally).toEqual({ yesPct: 62, role: 'DRep' });
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

describe('helpCardModel', () => {
  const guide = {
    title: 'How to vote on a governance action as a DRep',
    description: 'How a registered DRep casts a Yes, No, or Abstain vote on an open governance action.',
    category: 'For DReps',
    updated: new Date('2026-06-23'),
  };

  it('uses the hub category as the pill and the description as the subtitle', () => {
    const m = helpCardModel(guide);
    expect(m.accent).toBe(BRAND_ACCENT);
    expect(m.category).toBe('For DReps');
    expect(m.title).toBe(guide.title);
    expect(m.subtitle).toBe(guide.description);
    expect(m.authorName).toBeNull();
    expect(m.avatarDataUrl).toBeNull();
    expect(m.meta).toBe('Help guide · Updated 2026-06-23');
  });

  it('omits the updated date from the meta line when absent', () => {
    const m = helpCardModel({ ...guide, updated: undefined });
    expect(m.meta).toBe('Help guide');
  });

  it('clamps an overlong title on a word boundary (illustration takes the right third)', () => {
    const spaced = 'Managing your DRep: register, change metadata, get your deposit back';
    const m = helpCardModel({ ...guide, title: spaced });
    expect(m.title.length).toBeLessThanOrEqual(62);
    expect(m.title.endsWith('…')).toBe(true);
    // The visible prefix is a whole-word prefix of the original: the cut sits on a space.
    const base = m.title.slice(0, -1);
    expect(spaced.startsWith(base)).toBe(true);
    expect(spaced[base.length]).toBe(' ');
  });

  it('hard-cuts a title with no nearby word boundary and truncates the description', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(12).trim();
    const m = helpCardModel({ ...guide, title: 'x'.repeat(200), description: long });
    expect(m.title.length).toBeLessThanOrEqual(62);
    expect(m.title.endsWith('…')).toBe(true);
    expect(m.subtitle).toMatch(/\S\.\.\.$/);
    expect((m.subtitle as string).length).toBeLessThan(150);
  });
});

describe('moversCardModel', () => {
  // 100 -> 140 ada is a +40% gain; the reverse a loss. Values are lovelace strings.
  const gain: MoverInput = {
    name: 'CryptoCrow',
    snapshot: '140000000',
    prev: '100000000',
  };
  const loss: MoverInput = {
    name: 'NEDSCAVE.IO',
    snapshot: '75000000',
    prev: '100000000',
  };

  it('derives the epoch pill and subtitle, and the per-row percent and ada delta', () => {
    const m = moversCardModel({ epoch: 643, gainers: [gain], losers: [loss] });
    expect(m.epochLabel).toBe('Epoch 643');
    expect(m.subtitle).toContain('epoch 643');
    expect(m.gainers[0].pct).toBe('40.0%');
    expect(m.gainers[0].ada).toBe('40 ₳');
    // The chip carries direction via colour/arrow, so the figure is unsigned.
    expect(m.losers[0].pct).toBe('25.0%');
    expect(m.losers[0].ada).toBe('25 ₳');
  });

  it('falls back to a generic epoch label and clamps overlong names', () => {
    const m = moversCardModel({
      epoch: null,
      gainers: [{ ...gain, name: 'x'.repeat(40) }],
      losers: [],
    });
    expect(m.epochLabel).toBe('Latest epoch');
    expect(m.subtitle).toContain('this epoch');
    expect(m.gainers[0].name.length).toBeLessThanOrEqual(22);
    expect(m.gainers[0].name.endsWith('…')).toBe(true);
    expect(m.losers).toHaveLength(0);
  });

  it('shows no percent when the previous snapshot was zero', () => {
    const m = moversCardModel({
      epoch: 643,
      gainers: [{ ...gain, prev: '0' }],
      losers: [],
    });
    expect(m.gainers[0].pct).toBeNull();
    expect(m.gainers[0].ada).toBe('140 ₳');
  });

  it('shows no percent when the baseline was too small for one to mean anything', () => {
    // 6.3 ₳ to 805.9K ₳: the card leads with the amount instead of six digits of percent.
    const m = moversCardModel({
      epoch: 643,
      gainers: [{ ...gain, snapshot: '805900000000', prev: '6300000' }],
      losers: [],
    });
    expect(m.gainers[0].pct).toBeNull();
    expect(m.gainers[0].ada).toBe('805.9K ₳');
  });

  it('renders an html card that includes both columns and the movers data', () => {
    const html = moversCardHtml(moversCardModel({ epoch: 643, gainers: [gain], losers: [loss] }));
    expect(html).toContain('Movers of the epoch');
    expect(html).toContain('Top gainers');
    expect(html).toContain('Top losers');
    expect(html).toContain('CryptoCrow');
    expect(html).toContain('NEDSCAVE.IO');
    // Every flex container satori needs is declared; no bare multi-child div slipped in.
    expect(html).not.toMatch(/<div (?![^>]*display:flex)[^>]*>\s*</);
  });
});

describe('voteCardModel', () => {
  it('maps vote to a coloured label and clamps the excerpt', () => {
    const m = voteCardModel(
      { name: 'Maya Okafor', voterId: 'drep1abc', vote: 'No', rationaleText: 'x'.repeat(300), actionTitle: 'Fund Core Infra', role: 'DRep' },
      { avatarDataUrl: 'data:,' },
    );
    expect(m.votePhrase).toBe('voted No');
    expect(m.voteColor).toBe(TALLY.no);
    expect(m.rationaleExcerpt.endsWith('…')).toBe(true);
    expect(m.roleLabel).toBe('DRep');
  });
  it('handles a lowercase (optimistic) vote value', () => {
    const m = voteCardModel(
      { name: 'Ada', voterId: 'drep1abc', vote: 'yes', rationaleText: 'short', actionTitle: 'X', role: 'DRep' },
      { avatarDataUrl: 'data:,' },
    );
    expect(m.votePhrase).toBe('voted Yes');
    expect(m.voteColor).toBe(TALLY.yes);
  });
});

describe('analyticsCardModel', () => {
  const series = [
    { epoch: 640, totalDrepPower: '1000000000000000' },
    { epoch: 641, totalDrepPower: '1100000000000000' },
    { epoch: 643, totalDrepPower: '1200000000000000' },
  ];

  it('composes the headline, the chart over the series and three stats', () => {
    const m = analyticsCardModel({
      epoch: 643,
      powered: 1234,
      recentlyVoting: 512,
      totalPowerLovelace: '1200000000000000',
      abstainLovelace: '45000000000',
      halfCount: 17,
      circulationLovelace: '36000000000000000',
      series,
    });
    expect(m.accent).toBe(BRAND_ACCENT);
    expect(m.epochLabel).toBe('Epoch 643');
    expect(m.totalPowerLabel).toBe('1.2B ₳');
    expect(m.poweredLine).toBe('delegated to 1,234 DReps');
    expect(m.chart?.fromLabel).toBe('Epoch 640');
    expect(m.chart?.toLabel).toBe('Epoch 643');
    expect(m.chart?.line.startsWith('M0,')).toBe(true);
    expect(m.chart?.end.x).toBe(1104 - 16);
    // 1.2B of 36B circulating: 3.3%, the circulation share wins over the abstain figure.
    expect(m.stats).toEqual([
      { value: '512', label: 'voted in the last 12 epochs' },
      { value: '17', label: 'DReps hold half of the power' },
      { value: '3.3%', label: 'of circulating ada delegated' },
    ]);
    const html = analyticsCardHtml(m);
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('Delegated voting power, epoch by epoch');
    expect(html).toContain('Governance analytics');
  });

  it('drops the chart under two epochs and falls back to the abstain figure without a supply', () => {
    const m = analyticsCardModel({
      epoch: 643,
      powered: 3,
      recentlyVoting: 1,
      totalPowerLovelace: '5000000',
      abstainLovelace: '45000000000',
      halfCount: null,
      circulationLovelace: null,
      series: [{ epoch: 643, totalDrepPower: '5000000' }],
    });
    expect(m.chart).toBeNull();
    expect(m.stats).toEqual([
      { value: '1', label: 'voted in the last 12 epochs' },
      { value: '45K ₳', label: 'held by always abstain' },
    ]);
    expect(analyticsCardHtml(m)).not.toContain('Delegated voting power, epoch by epoch');
  });

  it('shows neither the half-power group nor a share when the inputs are unknown', () => {
    const m = analyticsCardModel({
      epoch: 643,
      powered: 3,
      recentlyVoting: 0,
      totalPowerLovelace: '5000000',
      abstainLovelace: null,
      halfCount: 0,
      circulationLovelace: '0',
      series,
    });
    expect(m.stats).toEqual([{ value: '0', label: 'voted in the last 12 epochs' }]);
  });
});
