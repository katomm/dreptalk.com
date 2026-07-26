/**
 * Rejects cross-origin browser calls to state-changing endpoints.
 *
 * The session cookie is already SameSite=Lax, so cookies are not attached to
 * cross-site POSTs and there is no open CSRF hole. This is defense in depth: it
 * also covers the endpoints that carry no cookie at all.
 *
 * Sec-Fetch-Site is preferred when present; Origin is the fallback. Requests
 * with neither header (non-browser clients such as curl) are allowed through,
 * since CSRF is a browser-only concern.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
