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

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  { group: 'Pages', label: 'Home', href: '/', keywords: 'home start dreptalk' },
  ...NAV_LINKS.map((l): StaticEntry => ({ group: 'Pages', label: l.label, href: l.href, keywords: '' })),
  { group: 'Pages', label: 'DReps', href: '/dreps', keywords: 'delegate representatives directory voting power' },
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
