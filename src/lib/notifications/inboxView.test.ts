// Node-env unit tests for the inbox view logic: counting, filtering,
// time-grouping and relative time.
import { describe, it, expect } from 'vitest';
import {
  countItems,
  filterItems,
  groupItems,
  relativeTime,
  type InboxItem,
} from './inboxView';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A fixed "now" at 12:00 local time so day-boundary math is unambiguous.
const NOW = new Date(2026, 6, 21, 12, 0, 0).getTime();

function item(kind: InboxItem['kind'], createdAt: number, unread = false): InboxItem {
  return {
    kind,
    createdAt,
    unread,
    actorName: kind === 'reply' || kind === 'mention' ? 'Alice' : null,
    actorHref: null,
    verb: kind === 'reply' ? 'replied in' : kind === 'mention' ? 'mentioned you in' : null,
    title: 't',
    href: '/t/x/',
    pill: null,
  };
}

describe('countItems + filterItems', () => {
  const items = [
    item('reply', NOW - HOUR, true),
    item('mention', NOW - 2 * HOUR),
    item('gov_created', NOW - 3 * HOUR, true),
    item('gov_status', NOW - 2 * DAY),
  ];

  it('counts per filter facet', () => {
    expect(countItems(items)).toEqual({ all: 4, unread: 2, mentions: 1, governance: 2, discussions: 1 });
  });

  it('filters each facet', () => {
    expect(filterItems(items, 'all')).toHaveLength(4);
    expect(filterItems(items, 'unread').every((i) => i.unread)).toBe(true);
    expect(filterItems(items, 'unread')).toHaveLength(2);
    expect(filterItems(items, 'mentions').map((i) => i.kind)).toEqual(['mention']);
    expect(filterItems(items, 'governance').map((i) => i.kind)).toEqual(['gov_created', 'gov_status']);
    expect(filterItems(items, 'discussions').map((i) => i.kind)).toEqual(['reply']);
  });
});

describe('groupItems', () => {
  it('splits into today, this week and earlier by local calendar day', () => {
    const items = [
      item('reply', NOW - HOUR), // today (11:00)
      item('mention', NOW - 13 * HOUR), // yesterday 23:00: this week
      item('gov_created', NOW - 5 * DAY), // this week
      item('gov_status', NOW - 10 * DAY), // earlier
    ];
    const groups = groupItems(items, NOW);
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ['today', 1],
      ['week', 2],
      ['earlier', 1],
    ]);
  });

  it('omits empty groups', () => {
    const groups = groupItems([item('reply', NOW - 10 * DAY)], NOW);
    expect(groups.map((g) => g.key)).toEqual(['earlier']);
  });
});

describe('device_paired inbox rows', () => {
  const deviceItem = {
    kind: 'device_paired' as const,
    createdAt: 1_700_000_000,
    unread: true,
    actorName: null,
    actorHref: null,
    verb: null,
    title: 'A new device was paired',
    href: '/devices/',
    pill: null,
  };

  it('counts toward all and unread but not mentions, governance or discussions', () => {
    const counts = countItems([deviceItem]);
    expect(counts.all).toBe(1);
    expect(counts.unread).toBe(1);
    expect(counts.mentions).toBe(0);
    expect(counts.governance).toBe(0);
    expect(counts.discussions).toBe(0);
  });

  it('survives every filter that should not exclude it', () => {
    expect(filterItems([deviceItem], 'all')).toHaveLength(1);
    expect(filterItems([deviceItem], 'unread')).toHaveLength(1);
    expect(filterItems([deviceItem], 'mentions')).toHaveLength(0);
    expect(filterItems([deviceItem], 'governance')).toHaveLength(0);
    expect(filterItems([deviceItem], 'discussions')).toHaveLength(0);
  });
});

describe('delegation_changed inbox rows', () => {
  const delegationItem = {
    kind: 'delegation_changed' as const,
    createdAt: 1_700_000_000,
    unread: true,
    actorName: null,
    actorHref: null,
    verb: null,
    title: 'Your delegation changed to Always Abstain',
    href: '/home/',
    pill: null,
  };

  it('counts toward all and unread but not mentions, governance or discussions', () => {
    const counts = countItems([delegationItem]);
    expect(counts.all).toBe(1);
    expect(counts.unread).toBe(1);
    expect(counts.mentions).toBe(0);
    expect(counts.governance).toBe(0);
    expect(counts.discussions).toBe(0);
  });

  it('survives every filter that should not exclude it', () => {
    expect(filterItems([delegationItem], 'all')).toHaveLength(1);
    expect(filterItems([delegationItem], 'unread')).toHaveLength(1);
    expect(filterItems([delegationItem], 'mentions')).toHaveLength(0);
    expect(filterItems([delegationItem], 'governance')).toHaveLength(0);
    expect(filterItems([delegationItem], 'discussions')).toHaveLength(0);
  });
});

describe('delegator DRep-event inbox rows', () => {
  const voteItem = {
    kind: 'delegator_drep_voted' as const,
    createdAt: 1_700_000_000,
    unread: true,
    actorName: null,
    actorHref: null,
    verb: null,
    title: 'Your DRep voted on Reduce fees',
    href: '/t/reduce-fees/',
    pill: null,
  };

  it('counts toward governance (and all/unread), not mentions or discussions', () => {
    const counts = countItems([voteItem]);
    expect(counts.all).toBe(1);
    expect(counts.unread).toBe(1);
    expect(counts.mentions).toBe(0);
    expect(counts.governance).toBe(1);
    expect(counts.discussions).toBe(0);
  });

  it('filterItems("governance") includes it', () => {
    expect(filterItems([voteItem], 'governance')).toHaveLength(1);
    expect(filterItems([voteItem], 'mentions')).toHaveLength(0);
    expect(filterItems([voteItem], 'discussions')).toHaveLength(0);
  });

  it('the re-voted and status-changed kinds also count and filter under governance', () => {
    const reVoteItem = item('delegator_drep_re_voted', 1_700_000_000);
    const statusItem = item('delegator_drep_status_changed', 1_700_000_000);
    for (const inboxItem of [reVoteItem, statusItem]) {
      expect(countItems([inboxItem]).governance).toBe(1);
      expect(filterItems([inboxItem], 'governance')).toHaveLength(1);
    }
  });

  it('a delegation_changed item is NOT counted or filtered under governance', () => {
    const delegationItem = {
      kind: 'delegation_changed' as const,
      createdAt: 1_700_000_000,
      unread: true,
      actorName: null,
      actorHref: null,
      verb: null,
      title: 'Your delegation changed to Always Abstain',
      href: '/home/',
      pill: null,
    };
    expect(countItems([delegationItem]).governance).toBe(0);
    expect(filterItems([delegationItem], 'governance')).toHaveLength(0);
  });

  it('an item with href: null is still returned by filterItems("all") and counted', () => {
    const noLinkItem = { ...voteItem, href: null };
    expect(filterItems([noLinkItem], 'all')).toHaveLength(1);
    expect(countItems([noLinkItem]).all).toBe(1);
    expect(countItems([noLinkItem]).governance).toBe(1);
  });
});

describe('drep_stats inbox rows', () => {
  it('keeps drep_stats out of the governance tab (all/unread only)', () => {
    const item = {
      kind: 'drep_stats' as const,
      createdAt: 1,
      unread: true,
      actorName: null,
      actorHref: null,
      verb: null,
      title: 'Epoch 570: voting power 65.2M ₳ (+3.2%)',
      href: '/dreps/drep1abc/',
      pill: null,
    };
    const counts = countItems([item]);
    expect(counts.all).toBe(1);
    expect(counts.governance).toBe(0);
    expect(filterItems([item], 'governance')).toHaveLength(0);
    expect(filterItems([item], 'unread')).toHaveLength(1);
  });
});

describe('rationale_ready inbox rows', () => {
  it('keeps rationale_ready out of the governance tab (all/unread only)', () => {
    const item = {
      kind: 'rationale_ready' as const,
      createdAt: 1,
      unread: true,
      actorName: null,
      actorHref: null,
      verb: null,
      title: 'Your rationale on Some Action is ready to share',
      href: '/dreps/drep1abc/vote/some-action/',
      pill: null,
    };
    const counts = countItems([item]);
    expect(counts.all).toBe(1);
    expect(counts.governance).toBe(0);
    expect(filterItems([item], 'governance')).toHaveLength(0);
    expect(filterItems([item], 'unread')).toHaveLength(1);
  });
});

describe('relativeTime', () => {
  it('formats the usual buckets', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 12 * DAY, NOW)).toBe('12d ago');
    expect(relativeTime(NOW - 65 * DAY, NOW)).toBe('2mo ago');
  });
});
