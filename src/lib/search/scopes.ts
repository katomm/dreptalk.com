// Scope vocabulary shared by the palette, the /search page, and the API.
export type Scope = 'all' | 'forum' | 'governance' | 'dreps' | 'spos' | 'rationales' | 'reviews' | 'help';

export const SCOPES: readonly Scope[] = ['all', 'forum', 'governance', 'dreps', 'spos', 'rationales', 'reviews', 'help'];

/** URL of the /search results page for a query, scope and page. */
export function searchPageHref(q: string, scope: Scope = 'all', page = 1): string {
  return `/search/?q=${encodeURIComponent(q)}${scope === 'all' ? '' : `&scope=${scope}`}${page > 1 ? `&page=${page}` : ''}`;
}

// Page size for the /search results page. Lives here (client-safe) so the
// browser island can import it without pulling in the D1 query module.
export const PAGE_SIZE = 20;

// Display labels, also the palette's group headers and the /search group
// titles. The forum scope is shown as "Discussions" to match the site's nav;
// the scope key stays `forum`.
export const SCOPE_LABELS: Record<Scope, string> = {
  all: 'All',
  forum: 'Discussions',
  governance: 'Governance Actions',
  dreps: 'DReps',
  spos: 'SPOs',
  rationales: 'Rationales',
  reviews: 'Reviews',
  help: 'Help',
};

/** Badge on the "Exact match" row, by the kind of id that resolved. */
export const EXACT_KIND_LABELS: Record<'governance-action' | 'drep' | 'pool', string> = {
  'governance-action': 'Governance Action',
  drep: 'DRep',
  pool: 'SPO',
};

/** One line saying a pool exists on chain but never voted, for the palette and
 *  the /search page. Ticker first, the way delegators know their pool. */
export function poolNoticeText(n: { poolId: string; ticker: string | null; name: string | null }): string {
  const who = [n.ticker ? `[${n.ticker}]` : null, n.name].filter(Boolean).join(' ') || 'This pool';
  return `${who} has not voted on any governance action yet.`;
}

export function isScope(raw: string | null): raw is Scope {
  return raw != null && (SCOPES as readonly string[]).includes(raw);
}

/** Unknown or absent scopes collapse to "all". */
export function parseScope(raw: string | null): Scope {
  return isScope(raw) ? raw : 'all';
}

/** The search filter a page pre-selects when its palette opens. Listing pages
 *  start their search inside the matching filter, everything else starts in
 *  "all". DRep *profile* pages (/dreps/<id>) intentionally stay on "all": only
 *  the two DRep listing pages pre-select "dreps". Query strings are not part of
 *  a pathname, so callers pass Astro.url.pathname directly. */
export function scopeForPath(pathname: string): Scope {
  const p = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (p.startsWith('/help/') || p.startsWith('/glossary/')) return 'help';
  if (p.startsWith('/governance-review/')) return 'reviews';
  if (p.startsWith('/discussions/')) return 'forum';
  if (p === '/dreps/' || p === '/dreps/movers/') return 'dreps';
  if (p.startsWith('/c/')) {
    return p === '/c/governance-actions/' || p === '/c/budget/' ? 'governance' : 'forum';
  }
  return 'all';
}
