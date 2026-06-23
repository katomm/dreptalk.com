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
}

const PAGE_KEYWORDS: Record<string, string> = {
  '/dreps': 'delegate representatives directory voting power',
  '/c/governance-actions': 'proposals votes ga',
  '/discussions': 'forum topics threads',
};

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  { group: 'Pages', label: 'Home', href: '/', keywords: 'home start dreptalk' },
  ...NAV_LINKS.map((l): StaticEntry => ({ group: 'Pages', label: l.label, href: l.href, keywords: PAGE_KEYWORDS[l.href] ?? '' })),
  { group: 'Pages', label: 'Help', href: '/help', keywords: 'documentation guide faq guides' },
];

/** Case-insensitive label/keyword filter; empty query returns everything. */
export function matchEntries<T extends { label: string; keywords: string }>(entries: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (e) => e.label.toLowerCase().includes(needle) || e.keywords.toLowerCase().includes(needle),
  );
}

/** Pages-group static entries matching the query. */
export function matchStaticEntries(q: string): StaticEntry[] {
  return matchEntries(STATIC_ENTRIES, q);
}
