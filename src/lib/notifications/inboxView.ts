// Pure view logic for the notifications inbox island: filtering, counting,
// time-grouping and relative time. Kept free of DOM/React/DB so it is
// unit-testable in node; the island only renders what these functions return.

export type InboxKind =
  | 'reply'
  | 'mention'
  | 'gov_created'
  | 'gov_status'
  | 'device_paired'
  | 'delegation_changed'
  | 'delegator_drep_voted'
  | 'delegator_drep_re_voted'
  | 'delegator_drep_status_changed'
  | 'drep_stats'
  | 'rationale_ready';

export interface InboxItem {
  kind: InboxKind;
  createdAt: number;
  unread: boolean;
  /** Display name of the acting user for reply/mention rows; null for gov rows. */
  actorName: string | null;
  /** Profile link for the actor, when one exists. */
  actorHref: string | null;
  /** Lead-in phrase between actor and title, e.g. "replied in". */
  verb: string | null;
  title: string;
  /** Null when there is nowhere to link (e.g. a governance action with no
      hydrated topic slug yet); the row still renders, just without an anchor. */
  href: string | null;
  /** Status pill, precomputed server-side from the shared statusBadge helper. */
  pill: { label: string; tone: 'active' | 'positive' | 'negative' | 'neutral'; outline: boolean } | null;
}

export type InboxFilter = 'all' | 'unread' | 'mentions' | 'governance' | 'discussions';

export interface InboxCounts {
  all: number;
  unread: number;
  mentions: number;
  governance: number;
  discussions: number;
}

/** Rows shown per group before the rest collapses behind "View N more". */
export const GROUP_VISIBLE = 5;

// delegation_changed, drep_stats and rationale_ready are deliberately
// excluded: personal events about your own account are not governance
// activity, so they stay all/unread only, never the governance tab.
const GOV_KINDS: ReadonlySet<InboxKind> = new Set([
  'gov_created',
  'gov_status',
  'delegator_drep_voted',
  'delegator_drep_re_voted',
  'delegator_drep_status_changed',
]);

export function countItems(items: InboxItem[]): InboxCounts {
  return {
    all: items.length,
    unread: items.filter((i) => i.unread).length,
    mentions: items.filter((i) => i.kind === 'mention').length,
    governance: items.filter((i) => GOV_KINDS.has(i.kind)).length,
    discussions: items.filter((i) => i.kind === 'reply').length,
  };
}

export function filterItems(items: InboxItem[], filter: InboxFilter): InboxItem[] {
  switch (filter) {
    case 'unread':
      return items.filter((i) => i.unread);
    case 'mentions':
      return items.filter((i) => i.kind === 'mention');
    case 'governance':
      return items.filter((i) => GOV_KINDS.has(i.kind));
    case 'discussions':
      return items.filter((i) => i.kind === 'reply');
    default:
      return items;
  }
}

export interface InboxGroup {
  key: 'today' | 'week' | 'earlier';
  label: string;
  items: InboxItem[];
}

/**
 * Groups items into Today / This week / Earlier by the viewer's local
 * calendar day. "This week" means the last seven days excluding today, which
 * matches how the groups read, not ISO weeks. Empty groups are omitted.
 */
export function groupItems(items: InboxItem[], now: number): InboxGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const weekMs = todayMs - 6 * 24 * 60 * 60 * 1000;

  const groups: InboxGroup[] = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'week', label: 'This week', items: [] },
    { key: 'earlier', label: 'Earlier', items: [] },
  ];
  for (const item of items) {
    if (item.createdAt >= todayMs) groups[0].items.push(item);
    else if (item.createdAt >= weekMs) groups[1].items.push(item);
    else groups[2].items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Compact relative time: "2h ago", "3d ago", falling back to "just now". */
export function relativeTime(createdAt: number, now: number): string {
  const diff = Math.max(0, now - createdAt);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
