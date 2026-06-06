// Security headers for SSR (Worker-generated) responses.
//
// On Cloudflare Workers Static Assets, the public/_headers file only decorates
// static-asset responses; it is NOT applied to responses produced by the Worker
// (our SSR pages and API routes):
// https://developers.cloudflare.com/workers/static-assets/headers/
// So these headers must be attached from the Worker, which we do in the Astro
// middleware (src/middleware.ts).
//
// The Content-Security-Policy itself is emitted by Astro's security.csp feature
// (astro.config.mjs). With the Cloudflare adapter it arrives as a real response
// header carrying the per-build SHA-256 hashes of the island hydration runtime,
// so the CSP is not set here, only adjusted (see relaxStyleSrc below).

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  // Clickjacking protection for legacy browsers, alongside the CSP
  // frame-ancestors 'none' directive that Astro emits in the policy header.
  'X-Frame-Options': 'DENY',
};

const SECURITY_HEADER_ENTRIES = Object.entries(SECURITY_HEADERS);

const CSP_HEADER = 'Content-Security-Policy';

// The style-src value we want on every document: permissive inline styles, which
// is the project's long-standing posture (only script-src must be strict).
const RELAXED_STYLE_SRC = "style-src 'self' 'unsafe-inline'";

// Enforce the baseline security headers on a response, replacing any weaker
// value a route may have set.
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of SECURITY_HEADER_ENTRIES) {
    headers.set(name, value);
  }
}

// Relax the style-src directive of Astro's CSP header to 'self' 'unsafe-inline'.
//
// Astro's security.csp always hash-pins inline <style> blocks, which makes
// browsers ignore 'unsafe-inline' for the whole style-src directive and would
// then block the app's inline style="" attributes (React inline styles and
// Astro markup). style-src-attr is not a fix because Safari does not support it.
// script-src is left untouched, so scripts stay strict (hashes only).
//
// Replacing the existing directive (rather than appending) keeps this idempotent
// if a response ever already carries a relaxed style-src.
export function relaxStyleSrc(headers: Headers): void {
  const csp = headers.get(CSP_HEADER);
  if (!csp) return;
  const next = /style-src[^;]*/i.test(csp)
    ? csp.replace(/style-src[^;]*/i, RELAXED_STYLE_SRC)
    : `${csp.replace(/;\s*$/, '')}; ${RELAXED_STYLE_SRC}`;
  headers.set(CSP_HEADER, next);
}
