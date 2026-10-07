/**
 * Canonical trailing slash for page routes.
 *
 * Astro serves a page both with and without the trailing slash, and the
 * layout derives the canonical tag from the requested path. So /t/foo and
 * /t/foo/ each declared themselves canonical, two URLs for one page. All
 * internal links already carry the slash, the slashless variants arrive
 * through external links.
 *
 * Only GET and HEAD are redirected, so a form or fetch that posts to a
 * slashless path keeps working. API routes and anything whose last segment
 * looks like a file (sitemap.xml, og images, cip100 JSON, csv exports) are
 * left alone, they have no slash variant.
 */
const REDIRECT_METHODS = new Set(['GET', 'HEAD']);

/** Target URL with the trailing slash appended, or null when no redirect applies. */
export function trailingSlashRedirect(request: Request): string | null {
  if (!REDIRECT_METHODS.has(request.method)) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.endsWith('/')) return null;
  if (path === '/api' || path.startsWith('/api/')) return null;
  if (path.startsWith('/_')) return null;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return null;
  url.pathname = `${path}/`;
  return url.toString();
}
