// Request handling for the drep.link resolver worker. Kept in src/lib so the
// workers test project covers it. The worker entry only wires bindings.
import type { NetworkConfig } from '../config/network.js';
import { drepPath } from '../dreps/profile.js';
import { searchPageHref } from '../search/scopes.js';
import { resolveHandle } from '../db/drepHandles.js';
import { routeFor } from './resolve.js';
import { renderLanding } from './landing.js';
import { DREP_LINK_ORIGIN } from './handle.js';

const REDIRECT_TTL = 300;
const LANDING_TTL = 3600;

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': `public, max-age=${REDIRECT_TTL}` },
  });
}

export interface ResolverDeps {
  db: D1Database;
  cfg: NetworkConfig;
  /** Unix seconds. */
  now: number;
  cache: Cache | null;
}

export async function handleRequest(req: Request, deps: ResolverDeps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const route = routeFor(new URL(req.url));
  const site = deps.cfg.siteOrigin;

  switch (route.kind) {
    case 'landing': {
      const key = new Request(`${DREP_LINK_ORIGIN}/`);
      let res = deps.cache ? await deps.cache.match(key) : undefined;
      if (!res) {
        res = new Response(renderLanding({ siteOrigin: site, linkOrigin: DREP_LINK_ORIGIN }), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${LANDING_TTL}` },
        });
        if (deps.cache) await deps.cache.put(key, res.clone());
      }
      return req.method === 'HEAD' ? new Response(null, { headers: res.headers }) : res;
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
      const res = redirect(
        found
          ? `${site}${drepPath({ drepId: found.drepId, slug: found.slug })}`
          : `${site}${searchPageHref(route.handle, 'dreps')}`,
      );
      if (deps.cache) await deps.cache.put(key, res.clone());
      return res;
    }
  }
}
