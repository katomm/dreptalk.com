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
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Central middleware gate: 403 for cross-origin browser writes, null otherwise.
 *
 * Complements SameSite=Lax at the exact-origin level: Lax still attaches the
 * cookie on same-site requests, so a compromised sibling origin (for example
 * the preprod host) could otherwise send credentialed writes. Non-browser
 * callers (webhooks, curl) send neither Sec-Fetch-Site nor Origin and pass
 * through, so no per-route exception list is needed. Routes with their own
 * isSameOriginRequest check keep it; this is the blanket underneath.
 */
export function crossOriginWriteResponse(request: Request): Response | null {
  if (!UNSAFE_METHODS.has(request.method)) return null;
  if (isSameOriginRequest(request)) return null;
  return new Response(JSON.stringify({ ok: false, error: 'cross-origin request rejected' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

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
