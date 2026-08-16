// CORS for the CIP-100 documents. These are public, read-only, credential-free
// bytes whose entire purpose is being fetched by somebody else's tool, so the
// origin is wide open and no credentials are ever allowed.
//
// Two details are load-bearing rather than decorative:
//
//  - `If-None-Match` is not a CORS-safelisted request header, so a browser
//    revalidating a snapshot sends an OPTIONS preflight first. Without an
//    answer to that preflight the conditional request never happens, and
//    revalidation is exactly what this feature uses instead of `immutable`.
//  - A cross-origin response only exposes a handful of headers to script.
//    ETag is not among them by default, so a client could not read the value
//    it is supposed to send back.
const BASE = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'ETag',
} as const;

/** Response headers for any CIP-100 document, including the error responses:
 *  a browser client that cannot read the status cannot tell a 404 from a
 *  network failure. */
export function corsHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...BASE, ...extra };
}

/** Preflight answer, shared by every CIP-100 route. */
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'If-None-Match',
      'access-control-max-age': '86400',
    },
  });
}
