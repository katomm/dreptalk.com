// Graceful degradation for render failures.
//
// When a page render throws because the D1 backend is briefly unavailable
// (a Cloudflare-side storage/Durable-Object hiccup, not a bug in our SQL), the
// middleware catches it and serves a friendly 503. Any other error keeps its
// 500 status, so it stays visible in logs and error rates, but gets the same
// friendly page instead of a blank response. Both pages are fully
// self-contained: they inline their own tokens and styles and run no scripts
// and no database reads, so they render even when the site's own layout is
// part of what failed.

// Message fragments that mark a transient D1/storage infrastructure failure,
// where the right answer is "try again shortly" rather than a 500. Taken from
// the D1 error reference, and deliberately scoped to infra faults: a
// deterministic query bug (e.g. "no such column") is NOT listed, so it still
// surfaces as a 500 and gets noticed.
// https://developers.cloudflare.com/d1/observability/debug-d1/
const INFRA_SIGNATURES = [
  'internal error',
  'object to be reset',
  'network connection lost',
  'cannot resolve d1 db',
  'is overloaded',
  'exceeded maximum db size',
  'exceeded its cpu time limit',
  'exceeded its memory limit',
  'reset because its code was updated',
  'storage operation exceeded timeout',
];

// Pull a message out of whatever was thrown: an Error, a string, or an object
// carrying a `message`/`cause`. D1 surfaces failures as Error instances (often
// with a wrapped `cause`), so both levels are checked.
function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const parts: string[] = [];
    const maybe = err as { message?: unknown; cause?: unknown };
    if (typeof maybe.message === 'string') parts.push(maybe.message);
    if (maybe.cause) parts.push(extractMessage(maybe.cause));
    return parts.join(' ');
  }
  return '';
}

/**
 * True when a thrown error looks like a transient D1 unavailability, i.e. the
 * database backend is temporarily unreachable and a retry is the fix. Returns
 * false for ordinary application errors so they keep their normal 500.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  const msg = extractMessage(err).toLowerCase();
  if (!msg) return false;
  return INFRA_SIGNATURES.some((sig) => msg.includes(sig));
}

// The DRepTalk burst mark, inline so it inherits currentColor. Mirrors
// src/components/LogoMark.astro; kept in sync by hand (this page must not import
// Astro components, so it can render with no build/runtime dependencies).
const LOGO_MARK = `<svg viewBox="0 0 72 72" fill="currentColor" aria-hidden="true" width="44" height="44">
  <g stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
    <line x1="36" y1="27.5" x2="36" y2="19.5"/><line x1="42" y1="30" x2="47.7" y2="24.3"/>
    <line x1="44.5" y1="36" x2="52.5" y2="36"/><line x1="42" y1="42" x2="47.7" y2="47.7"/>
    <line x1="36" y1="44.5" x2="36" y2="52.5"/><line x1="30" y1="42" x2="24.3" y2="47.7"/>
    <line x1="27.5" y1="36" x2="19.5" y2="36"/><line x1="30" y1="30" x2="24.3" y2="24.3"/>
  </g>
  <circle cx="36" cy="15" r="4"/><circle cx="50.85" cy="21.15" r="4"/><circle cx="57" cy="36" r="4"/>
  <circle cx="50.85" cy="50.85" r="4"/><circle cx="36" cy="57" r="4"/><circle cx="21.15" cy="50.85" r="4"/>
  <circle cx="15" cy="36" r="4"/><circle cx="21.15" cy="21.15" r="4"/>
  <circle cx="47.1" cy="9.2" r="2"/><circle cx="62.8" cy="24.9" r="2"/><circle cx="62.8" cy="47.1" r="2"/>
  <circle cx="47.1" cy="62.8" r="2"/><circle cx="24.9" cy="62.8" r="2"/><circle cx="9.2" cy="47.1" r="2"/>
  <circle cx="9.2" cy="24.9" r="2"/><circle cx="24.9" cy="9.2" r="2"/>
  <circle cx="36" cy="36" r="7"/>
</svg>`;

interface ErrorPageCopy {
  title: string;
  heading: string;
  /** Already-escaped HTML fragments, authored here, never from user input. */
  lead: string;
  note: string;
  secondary: { href: string; label: string };
}

// The full HTML document. Tokens are inlined for both themes and switched on the
// OS preference (prefers-color-scheme): the site's manual theme toggle relies on
// a script + localStorage that this scriptless page cannot run, and following
// the OS is the sensible, robust fallback for an error page.
const renderPage = (copy: ErrorPageCopy): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light dark"/>
<meta name="robots" content="noindex"/>
<title>${copy.title} - DRepTalk</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<style>
:root{
  --bg:#ffffff;--surface:#f7f7fb;--fg:#17141f;--muted:#6b6880;--border:#ece9f4;
  --accent:#6d28d9;--accent-fg:#ffffff;--accent-hover:#5b21b6;
  --grad:linear-gradient(120deg,#8b5cf6 0%,#3b82f6 50%,#2dd4bf 100%);
  --font:'Plus Jakarta Sans',ui-sans-serif,system-ui,-apple-system,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0c0a12;--surface:#141019;--fg:#ece9f4;--muted:#9d99ad;--border:#272233;
    --accent:#a78bfa;--accent-fg:#14101c;--accent-hover:#b9a3fb;
    --grad:linear-gradient(120deg,#a78bfa 0%,#60a5fa 50%,#5eead4 100%);
  }
}
@font-face{
  font-family:'Plus Jakarta Sans';
  src:url('/fonts/plus-jakarta-sans-latin.woff2') format('woff2');
  font-weight:200 800;font-style:normal;font-display:swap;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);
  line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  display:flex;flex-direction:column;min-height:100vh;
}
main{
  flex:1 0 auto;position:relative;display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;
  max-width:34rem;margin:0 auto;padding:5rem 1.5rem 6rem;
}
/* Soft brand-gradient glow behind the mark, echoing the home hero and 404. */
main::before{
  content:'';position:absolute;top:2rem;left:50%;transform:translateX(-50%);
  width:min(24rem,80%);height:13rem;background:var(--grad);
  filter:blur(80px);opacity:.16;z-index:-1;pointer-events:none;
}
.mark{color:var(--muted);margin-bottom:1.1rem}
.mark svg{display:block}
.brand{
  font-family:var(--font);font-weight:600;font-size:1.15rem;letter-spacing:-.01em;
  color:var(--muted);margin-bottom:2.25rem;
}
.brand .talk{
  background:var(--grad);-webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;color:transparent;
}
h1{
  font-family:var(--font);font-weight:700;line-height:1.2;
  font-size:clamp(1.6rem,5vw,2.25rem);margin:0;letter-spacing:-.01em;
}
.lead{
  color:var(--muted);font-size:1.0625rem;line-height:1.65;
  margin:1rem auto 2rem;max-width:30rem;
}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:center}
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  font-weight:600;font-size:.9375rem;line-height:1;text-decoration:none;
  padding:.75rem 1.25rem;border-radius:9px;border:1px solid transparent;
  transition:background-color .15s ease,color .15s ease,border-color .15s ease;
}
.btn-primary{background:var(--accent);color:var(--accent-fg)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:var(--surface);color:var(--fg);border-color:var(--border)}
.btn-secondary:hover{border-color:var(--accent);color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.note{margin-top:2.5rem;font-size:.85rem;color:var(--muted)}
.note a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}
</style>
</head>
<body>
<main role="main">
  <span class="mark">${LOGO_MARK}</span>
  <div class="brand">DRep<span class="talk">Talk</span></div>
  <h1>${copy.heading}</h1>
  <p class="lead">${copy.lead}</p>
  <div class="actions">
    <a class="btn btn-primary" href="/">Try again</a>
    <a class="btn btn-secondary" href="${copy.secondary.href}" rel="noopener">${copy.secondary.label}</a>
  </div>
  <p class="note">${copy.note}</p>
</main>
</body>
</html>`;

const UNAVAILABLE_HTML = renderPage({
  title: 'Briefly unavailable',
  heading: 'Briefly unavailable',
  lead:
    'DRepTalk is having a short hiccup reaching its data. Nothing is lost and it is ' +
    'nothing on your side, the forum will be back on its own in a moment.',
  note:
    'If this persists, we are already on it. You can also complain to us ' +
    '<a href="https://x.com/dreptalkcom" rel="noopener">on X</a>.',
  secondary: { href: 'https://www.cloudflarestatus.com/', label: 'Platform status' },
});

const INTERNAL_ERROR_HTML = renderPage({
  title: 'Something went wrong',
  heading: 'Something went wrong',
  lead:
    'This page hit an error on our side. It is logged, and a reload in a minute ' +
    'often helps. Nothing on your side caused it.',
  note:
    'If it keeps happening, feel free to nag us <a href="https://x.com/dreptalkcom" rel="noopener">on X</a> ' +
    'and mention which page it was.',
  secondary: { href: '/c/governance-actions/', label: 'Governance actions' },
});

// A tight, self-contained CSP for the error page: no scripts, inline styles
// only, images/fonts from our own origin. relaxStyleSrc() in the middleware
// rewrites style-src to the same value, so this stays consistent post-process.
const PAGE_CSP =
  "default-src 'self'; base-uri 'none'; script-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "frame-ancestors 'none'";

/**
 * A 503 "temporarily unavailable" response for a database outage. API routes
 * (/api/*) get a small JSON body so machine clients get structured output;
 * everything else gets the friendly HTML page. Marked no-store so the edge
 * never caches the outage, and Retry-After hints a short retry.
 */
export function serviceUnavailableResponse(pathname: string): Response {
  const common: Record<string, string> = {
    'Retry-After': '30',
    'Cache-Control': 'no-store',
  };
  if (pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({
        status: 'unavailable',
        error: 'The service is temporarily unavailable. Please retry shortly.',
      }),
      { status: 503, headers: { ...common, 'content-type': 'application/json; charset=utf-8' } },
    );
  }
  return new Response(UNAVAILABLE_HTML, {
    status: 503,
    headers: {
      ...common,
      'content-type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
    },
  });
}

/**
 * A 500 response for any other render failure: the status stays 500 so error
 * rates and logs keep seeing it, only the body is friendly. No Retry-After, a
 * bug does not fix itself in 30 seconds. No error detail reaches the visitor.
 */
export function internalErrorResponse(pathname: string): Response {
  if (pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ status: 'error', error: 'Something went wrong on our side. The error is logged.' }),
      { status: 500, headers: { 'Cache-Control': 'no-store', 'content-type': 'application/json; charset=utf-8' } },
    );
  }
  return new Response(INTERNAL_ERROR_HTML, {
    status: 500,
    headers: {
      'Cache-Control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
    },
  });
}
