// Request handling for the drep.link resolver worker. Kept in src/lib so the
// workers test project covers it. The worker entry only wires bindings.
import type { NetworkConfig } from '../config/network.js';
import { drepPath } from '../dreps/profile.js';
import { searchPageHref } from '../search/scopes.js';
import { listRecentDrepHandles, resolveHandle } from '../db/drepHandles.js';
import { ACTIVE_WINDOW_MS, CARD_FACE_LIMIT } from '../forum/view.js';
import { routeFor } from './resolve.js';
import { renderLanding } from './landing.js';
import { DREP_LINK_ORIGIN, isRoutableHandle } from './handle.js';

// A found handle changes rarely (90-day cooldown, old links keep redirecting),
// so it may stay cached for an hour. Everything else stays short, so a freshly
// claimed handle is not hidden behind a cached search redirect for long.
const HIT_TTL = 3600;
const REDIRECT_TTL = 300;
const LANDING_TTL = 3600;
// The landing page picks a fresh example per request, so browsers keep it only
// briefly. The candidate list behind it is cached for an hour.
const LANDING_BROWSER_TTL = 300;
const EXAMPLES_TTL = 3600;
const FALLBACK_EXAMPLE = 'adatainment';

function redirect(location: string, ttl = REDIRECT_TTL): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': `public, max-age=${ttl}` } });
}

export interface ResolverDeps {
  db: D1Database;
  cfg: NetworkConfig;
  /** Unix seconds. */
  now: number;
  cache: Cache | null;
  /** Lets cache writes finish after the response is sent. Awaited inline when absent. */
  waitUntil?: (p: Promise<unknown>) => void;
}

function store(deps: ResolverDeps, key: Request, res: Response): Promise<void> {
  if (!deps.cache) return Promise.resolve();
  const put = deps.cache.put(key, res.clone());
  if (deps.waitUntil) {
    deps.waitUntil(put);
    return Promise.resolve();
  }
  return put;
}

/**
 * Handles of recently signed-in DReps for the landing example, cached for an
 * hour so a page view costs no D1 read. Entries are re-checked for shape since
 * they go into the page unescaped.
 */
async function recentExamples(deps: ResolverDeps): Promise<string[]> {
  const key = new Request(`${DREP_LINK_ORIGIN}/__examples`);
  const hit = deps.cache ? await deps.cache.match(key) : undefined;
  if (hit) return ((await hit.json()) as string[]).filter(isRoutableHandle);
  const list = await listRecentDrepHandles(deps.db, deps.now * 1000 - ACTIVE_WINDOW_MS, CARD_FACE_LIMIT, deps.now);
  await store(
    deps,
    key,
    new Response(JSON.stringify(list), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${EXAMPLES_TTL}` },
    }),
  );
  return list.filter(isRoutableHandle);
}

export async function handleRequest(req: Request, deps: ResolverDeps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const route = routeFor(new URL(req.url));
  const site = deps.cfg.siteOrigin;

  switch (route.kind) {
    case 'landing': {
      const examples = await recentExamples(deps);
      const example = examples.length ? examples[Math.floor(Math.random() * examples.length)] : FALLBACK_EXAMPLE;
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${LANDING_BROWSER_TTL}` };
      if (req.method === 'HEAD') return new Response(null, { headers });
      return new Response(renderLanding({ siteOrigin: site, linkOrigin: DREP_LINK_ORIGIN, example }), { headers });
    }
    case 'robots':
      return new Response('User-agent: *\nAllow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${LANDING_TTL}` },
      });
    case 'lookup':
      return redirect(route.to);
    case 'id':
      return redirect(`${site}${drepPath({ drepId: route.drepId })}`);
    case 'search':
      return redirect(`${site}${searchPageHref(route.q, 'dreps')}`);
    case 'handle': {
      // Keyed by the lowercased handle, independent of case, slash and query.
      const key = new Request(`${DREP_LINK_ORIGIN}/${route.handle}`);
      const hit = deps.cache ? await deps.cache.match(key) : undefined;
      if (hit) return hit;
      const found = await resolveHandle(deps.db, route.handle, deps.now);
      const res = found
        ? redirect(`${site}${drepPath({ drepId: found.drepId, slug: found.slug })}`, HIT_TTL)
        : redirect(`${site}${searchPageHref(route.handle, 'dreps')}`);
      await store(deps, key, res);
      return res;
    }
  }
}
