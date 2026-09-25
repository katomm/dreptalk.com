// The drep.link landing page. A static HTML string, rendered by the resolver
// worker without a D1 read. Colors are DRepTalk's tokens from global.css, the
// font and logo come from the worker's own static assets.
// The DRepTalk burst mark from src/components/LogoMark.astro, painted in
// currentColor like the site header. Keep the two in sync.
const LOGO_MARK = `<svg viewBox="0 0 72 72" width="38" height="38" fill="currentColor" aria-hidden="true"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="36" y1="27.5" x2="36" y2="19.5" /><line x1="42" y1="30" x2="47.7" y2="24.3" /><line x1="44.5" y1="36" x2="52.5" y2="36" /><line x1="42" y1="42" x2="47.7" y2="47.7" /><line x1="36" y1="44.5" x2="36" y2="52.5" /><line x1="30" y1="42" x2="24.3" y2="47.7" /><line x1="27.5" y1="36" x2="19.5" y2="36" /><line x1="30" y1="30" x2="24.3" y2="24.3" /></g><circle cx="36" cy="15" r="4" /><circle cx="50.85" cy="21.15" r="4" /><circle cx="57" cy="36" r="4" /><circle cx="50.85" cy="50.85" r="4" /><circle cx="36" cy="57" r="4" /><circle cx="21.15" cy="50.85" r="4" /><circle cx="15" cy="36" r="4" /><circle cx="21.15" cy="21.15" r="4" /><circle cx="47.1" cy="9.2" r="2" /><circle cx="62.8" cy="24.9" r="2" /><circle cx="62.8" cy="47.1" r="2" /><circle cx="47.1" cy="62.8" r="2" /><circle cx="24.9" cy="62.8" r="2" /><circle cx="9.2" cy="47.1" r="2" /><circle cx="9.2" cy="24.9" r="2" /><circle cx="24.9" cy="9.2" r="2" /><circle cx="36" cy="36" r="7" /></svg>`;

/** `example` must be a validated handle, it goes into the page unescaped. */
export function renderLanding(o: { siteOrigin: string; linkOrigin: string; example: string }): string {
  const { siteOrigin, linkOrigin, example } = o;
  const host = new URL(linkOrigin).host;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>drep.link: short links to Cardano DRep profiles</title>
<meta name="description" content="Every Cardano DRep gets a free short link to their DRepTalk profile, like ${host}/yourname.">
<link rel="canonical" href="${linkOrigin}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${linkOrigin}/">
<meta property="og:title" content="drep.link">
<meta property="og:description" content="Free short links to Cardano DRep profiles on DRepTalk.">
<meta property="og:image" content="${siteOrigin}/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c0a12" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="preload" href="/fonts/plus-jakarta-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:'Plus Jakarta Sans';src:url(/fonts/plus-jakarta-sans-latin.woff2) format('woff2');font-weight:200 800;font-display:swap}
:root{--bg:#ffffff;--surface:#f7f7fb;--fg:#17141f;--muted:#6b6880;--border:#ece9f4;--accent:#6d28d9;--accent-hover:#5b21b6;--accent-fg:#fff;--grad:linear-gradient(120deg,#8b5cf6 0%,#3b82f6 50%,#2dd4bf 100%)}
@media (prefers-color-scheme: dark){:root{--bg:#0c0a12;--surface:#141019;--fg:#ece9f4;--muted:#9d99ad;--border:#272233;--accent:#a78bfa;--accent-hover:#c4b5fd;--accent-fg:#0c0a12;--grad:linear-gradient(120deg,#a78bfa 0%,#60a5fa 50%,#5eead4 100%)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 'Plus Jakarta Sans',system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:3rem 1rem 4rem}
.brand{display:inline-flex;align-items:center;gap:.4rem;text-decoration:none;color:var(--muted)}
.brand svg{display:block;width:38px;height:38px}
.brand__word{font-weight:600;font-size:1.25rem;letter-spacing:-.01em;line-height:1;color:var(--muted)}
.grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
h1{font-size:clamp(1.9rem,7vw,2.6rem);line-height:1.12;letter-spacing:-.02em;margin:2.5rem 0 .9rem;font-weight:800}
h1 span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
p{color:var(--muted);margin:0 0 1rem}
form{display:flex;align-items:stretch;border:1px solid var(--border);border-radius:14px;background:var(--surface);overflow:hidden;margin:1.75rem 0 .75rem}
form:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
form label{display:flex;align-items:center;padding:0 .1rem 0 1rem;color:var(--muted);white-space:nowrap;font-weight:600}
form input{flex:1;min-width:0;border:0;background:transparent;color:var(--fg);font:inherit;font-weight:600;padding:.9rem .25rem}
form input:focus{outline:none}
form button{border:0;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:700;padding:0 1.25rem;cursor:pointer}
form button:hover{background:var(--accent-hover)}
form button:focus-visible{outline:2px solid var(--fg);outline-offset:-4px}
.example{font-size:.95rem}
.card{border:1px solid var(--border);border-radius:14px;padding:1.25rem 1.25rem .5rem;background:var(--surface);margin-top:2.5rem}
.card h2{font-size:1.05rem;margin:0 0 .5rem}
a{color:var(--accent)}
code{font-family:inherit;font-weight:700;color:var(--fg)}
footer{margin-top:3rem;font-size:.9rem;color:var(--muted)}
@media (max-width:420px){form label{padding-left:.75rem}form button{padding:0 1rem}}
</style>
</head>
<body>
<main>
<a class="brand" href="${siteOrigin}/" aria-label="DRepTalk">${LOGO_MARK}<span class="brand__word">DRep<span class="grad">Talk</span></span></a>
<h1>Short links for <span>Cardano DReps</span></h1>
<p>Every DRep gets a free short link to their DRepTalk profile with votes, rationales and discussions. No sign-up, no fees. Put it in your bio, your posts or your slides.</p>
<form action="/" method="get" role="search">
<label for="h">${host}/</label>
<input id="h" name="h" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="yourname" maxlength="64" aria-label="DRep name">
<button type="submit">Open</button>
</form>
<p class="example">Example: <a href="/${example}"><code>${host}/${example}</code></a></p>
<section class="card">
<h2>Get your free drep.link</h2>
<p>If your DRep metadata has a name, your link already exists and is built from that name. You can pick a different one after logging in on DRepTalk with your DRep key.</p>
<p><a href="${siteOrigin}/settings/profile/">Open your DRep settings</a></p>
</section>
<footer>A <a href="${siteOrigin}/">DRepTalk</a> service. Every link points to a DRep's profile on DRepTalk.</footer>
</main>
</body>
</html>`;
}
