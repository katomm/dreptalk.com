// Static palette entries: top-level pages and help articles. Matched
// client-side, so the palette has useful content with zero server roundtrips
// (and still works when the API is unreachable).
import { NAV_LINKS } from '../config/nav.js';
import { HELP_ARTICLES } from '../help/articles.js';

export interface StaticEntry {
  group: 'Pages' | 'Help';
  label: string;
  href: string;
  keywords: string;
}

// Extra search keywords for nav pages, keyed by href.
const PAGE_KEYWORDS: Record<string, string> = {
  '/dreps': 'delegate representatives directory voting power',
  '/c/governance-actions': 'proposals votes ga',
  '/discussions': 'forum topics threads',
};

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  { group: 'Pages', label: 'Home', href: '/', keywords: 'home start dreptalk' },
  ...NAV_LINKS.map((l): StaticEntry => ({ group: 'Pages', label: l.label, href: l.href, keywords: PAGE_KEYWORDS[l.href] ?? '' })),
  { group: 'Pages', label: 'Help', href: '/help', keywords: 'documentation guide faq' },
  ...HELP_ARTICLES.map((a): StaticEntry => ({ group: 'Help', label: a.title, href: a.href, keywords: a.text })),
];

/** Case-insensitive label/keyword filter; empty query returns everything. */
export function matchStaticEntries(q: string): StaticEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...STATIC_ENTRIES];
  return STATIC_ENTRIES.filter(
    (e) => e.label.toLowerCase().includes(needle) || e.keywords.toLowerCase().includes(needle),
  );
}
