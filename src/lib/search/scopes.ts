// Scope vocabulary shared by the palette, the /search page, and the API.
export type Scope = 'all' | 'forum' | 'governance' | 'dreps' | 'rationales' | 'reviews' | 'help';

export const SCOPES: readonly Scope[] = ['all', 'forum', 'governance', 'dreps', 'rationales', 'reviews', 'help'];

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
  rationales: 'Rationales',
  reviews: 'Reviews',
  help: 'Help',
};

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
