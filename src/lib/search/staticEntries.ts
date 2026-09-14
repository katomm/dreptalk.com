// Static palette entries: top-level pages. Help entries are passed in from the
// server (they come from the guides content collection, which is server-only).
import { NAV_LINKS } from '../config/nav.js';

export interface StaticEntry {
  group: 'Pages' | 'Help';
  label: string;
  href: string;
  keywords: string;
}

export interface HelpEntry {
  label: string;
  href: string;
  keywords: string;
  // Short guide description, shown as a secondary line under the help title.
  description: string;
}

const PAGE_KEYWORDS: Record<string, string> = {
  '/dreps/': 'delegate representatives directory voting power',
  '/c/governance-actions/': 'proposals votes ga',
  '/discussions/': 'forum topics threads',
  '/analytics/': 'analytics stats governance health concentration abstain',
  '/governance-review/': 'review editions epochs articles analysis',
};

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  { group: 'Pages', label: 'Home', href: '/', keywords: 'home start dreptalk' },
  ...NAV_LINKS.map((l): StaticEntry => ({ group: 'Pages', label: l.label, href: l.href, keywords: PAGE_KEYWORDS[l.href.split('?')[0]] ?? '' })),
  // The Treasury nav link points at the budget category (the discussion). This
  // is the overview page itself, which is otherwise reachable only from a topic
  // sidebar or a glossary entry.
  { group: 'Pages', label: 'Net Change Limit', href: '/treasury/', keywords: 'treasury ncl budget withdrawals ceiling limit' },
  { group: 'Pages', label: 'Help', href: '/help/', keywords: 'documentation guide faq guides' },
  { group: 'Pages', label: 'Glossary', href: '/glossary/', keywords: 'definitions terms vocabulary governance glossary' },
  { group: 'Pages', label: 'Find your DRep', href: '/match/', keywords: 'match quiz find a drep delegate voting compare' },
  { group: 'Pages', label: 'Badges', href: '/badges/', keywords: 'badges achievements tiers gallery' },
];

/**
 * Pages that only exist for a signed-in user. Each one redirects to /login/ when
 * signed out, so they are offered only once there is a session: a palette row
 * that can only bounce you to the login screen is noise, not a shortcut.
 */
export const PERSONAL_ENTRIES: readonly StaticEntry[] = [
  { group: 'Pages', label: 'My DRep', href: '/my-drep/', keywords: 'my drep delegation dashboard delegator record since' },
  { group: 'Pages', label: 'Voting power origins', href: '/voting-power-origins/', keywords: 'voting power origins where came from delegators previous' },
  { group: 'Pages', label: 'Your governance record', href: '/my-governance-record/', keywords: 'my governance record percentile rank timing missed rationale' },
  { group: 'Pages', label: 'Notifications', href: '/notifications/', keywords: 'notifications inbox alerts push telegram unread' },
  { group: 'Pages', label: 'Settings', href: '/settings/', keywords: 'settings account profile metadata devices preferences' },
];

/** Case-insensitive label/keyword/description filter; empty query returns everything. */
export function matchEntries<T extends { label: string; keywords: string; description?: string }>(entries: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (e) =>
      e.label.toLowerCase().includes(needle) ||
      e.keywords.toLowerCase().includes(needle) ||
      (e.description?.toLowerCase().includes(needle) ?? false),
  );
}

/** Pages-group static entries matching the query. Personal pages are included
 *  only for a signed-in visitor, for whom they are not a redirect to /login/. */
export function matchStaticEntries(q: string, signedIn = false): StaticEntry[] {
  return matchEntries(signedIn ? [...STATIC_ENTRIES, ...PERSONAL_ENTRIES] : STATIC_ENTRIES, q);
}
