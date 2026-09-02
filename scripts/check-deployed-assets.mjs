#!/usr/bin/env node
// Post-deploy check: fetch a few public routes and confirm every stylesheet and
// script they name actually resolves. A deploy replaces the hashed asset
// manifest wholesale, so a page served from an older render points at bundles
// that no longer exist, and it arrives with no styles at all. The page cache is
// keyed by deploy id so that cannot happen through the cache any more, but a
// stale copy can still come from a CDN, a proxy or a browser, and this catches
// any other way a page ends up naming an asset that is gone.
//
// Run it after a deploy: npm run check:deployed
// Point it elsewhere with BASE_URL, for example a preview deployment.

const BASE = (process.env.BASE_URL ?? 'https://dreptalk.com').replace(/\/$/, '');

// A spread of routes rather than one: the home page, two cached synced pages,
// and two behind different layouts, so a single broken bundle cannot hide.
const ROUTES = ['/', '/dreps/', '/dreps/movers', '/analytics', '/discussions'];

// src of a script tag, href of a stylesheet link. Deliberately a regex and not
// a parser: this has to run with no dependencies, right after a deploy.
const ASSET_RE = /<(?:link[^>]+rel=["']stylesheet["'][^>]+href|script[^>]+src)=["']([^"']+)["']/gi;

const failures = [];

for (const route of ROUTES) {
  const pageUrl = `${BASE}${route}`;
  let html;
  try {
    const res = await fetch(pageUrl, { headers: { 'user-agent': 'dreptalk-asset-check' } });
    if (!res.ok) {
      failures.push(`${route} answered ${res.status}`);
      continue;
    }
    html = await res.text();
  } catch (err) {
    failures.push(`${route} could not be fetched: ${err.message}`);
    continue;
  }

  const assets = [...html.matchAll(ASSET_RE)]
    .map((m) => m[1])
    .filter((href) => !/^https?:|^data:/i.test(href));

  if (assets.length === 0) {
    failures.push(`${route} names no local stylesheet or script, which is itself suspicious`);
    continue;
  }

  for (const href of new Set(assets)) {
    const assetUrl = new URL(href, pageUrl).toString();
    const res = await fetch(assetUrl, { method: 'GET', headers: { 'user-agent': 'dreptalk-asset-check' } });
    const type = res.headers.get('content-type') ?? '';
    // A pruned asset does not 404 as a bare 404: the SSR worker answers with its
    // own HTML error page, so the content type is the honest signal.
    const isHtml = type.includes('text/html');
    const wantsCss = /\.css(\?|$)/i.test(href);
    if (!res.ok || isHtml) {
      failures.push(`${route} names ${href}, which answered ${res.status} as ${type || 'no content type'}`);
    } else if (wantsCss && !type.includes('css')) {
      failures.push(`${route} names ${href}, served as ${type} instead of CSS`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Asset check failed against ${BASE}:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`Asset check passed against ${BASE}: every stylesheet and script on ${ROUTES.length} routes resolves.`);
}
