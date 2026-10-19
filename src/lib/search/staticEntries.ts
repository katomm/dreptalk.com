// Static palette entries: top-level pages. Help guides, glossary terms and
// Governance Review editions come from the search API (lib/search/content.ts).
import { NAV_LINKS } from '../config/nav.js';

export interface StaticEntry {
  label: string;
  href: string;
  keywords: string;
}

const PAGE_KEYWORDS: Record<string, string> = {
  '/dreps/': 'delegate representatives directory voting power',
  '/c/governance-actions/': 'proposals votes ga',
  '/discussions/': 'forum topics threads',
  '/analytics/': 'analytics stats governance health concentration abstain',
  '/governance-review/': 'review editions epochs articles analysis',
  '/treasury/': 'treasury ncl net change limit budget withdrawals ceiling',
  '/help/': 'documentation guide faq guides',
  '/glossary/': 'definitions terms vocabulary governance glossary',
  '/match/': 'match quiz find a drep delegate voting compare',
  '/dreps/movers/': 'movers gains losses voting power epoch delegation shifts',
  '/badges/': 'badges achievements tiers gallery',
  '/register-drep/': 'register drep registration metadata wallet',
};

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  { label: 'Home', href: '/', keywords: 'home start dreptalk' },
  ...NAV_LINKS.map((l): StaticEntry => ({ label: l.label, href: l.href, keywords: PAGE_KEYWORDS[l.href.split('?')[0]] ?? '' })),
  // The budget discussion category. The Treasury entry in the header points at
  // the Net Change Limit overview, so the discussions get their own row here.
  { label: 'Treasury discussions', href: '/c/budget/', keywords: 'treasury budget withdrawals proposals discussion' },
];

/**
 * Pages that only exist for a signed-in user. Each one redirects to /login/ when
 * signed out, so they are offered only once there is a session: a palette row
 * that can only bounce you to the login screen is noise, not a shortcut.
 */
export const PERSONAL_ENTRIES: readonly StaticEntry[] = [
  { label: 'My DRep', href: '/my-drep/', keywords: 'my drep delegation dashboard delegator record since' },
  { label: 'Voting power origins', href: '/voting-power-origins/', keywords: 'voting power origins where came from delegators previous' },
  { label: 'Your governance record', href: '/my-governance-record/', keywords: 'my governance record percentile rank timing missed rationale' },
  { label: 'Notifications', href: '/notifications/', keywords: 'notifications inbox alerts push telegram unread' },
  { label: 'Settings', href: '/settings/', keywords: 'settings account profile metadata devices preferences' },
];

/** Page entries whose label or keywords contain the query, case-insensitive.
 *  An empty query returns every page. Personal pages are included only for a
 *  signed-in visitor, for whom they are not a redirect to /login/. */
export function matchStaticEntries(q: string, signedIn = false): StaticEntry[] {
  const entries = signedIn ? [...STATIC_ENTRIES, ...PERSONAL_ENTRIES] : [...STATIC_ENTRIES];
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.label.toLowerCase().includes(needle) || e.keywords.toLowerCase().includes(needle));
}
