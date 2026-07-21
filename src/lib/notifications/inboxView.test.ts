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

describe('relativeTime', () => {
  it('formats the usual buckets', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 12 * DAY, NOW)).toBe('12d ago');
    expect(relativeTime(NOW - 65 * DAY, NOW)).toBe('2mo ago');
  });
});
