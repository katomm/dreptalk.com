// The "What's new" guide keeps the last release list GitHub answered with, so a
// failed fetch (rate limit, timeout, outage) shows that list instead of none.
// Lives apart from releases.ts because it needs the Workers runtime, which the
// node unit tests of the parsing code do not have.
import { waitUntil } from 'cloudflare:workers';
import { fetchReleases, type ReleaseItem } from './releases.js';

// Thirty days: long enough to ride out any GitHub outage, and every successful
// render overwrites it anyway.
const KEEP_SECONDS = 30 * 24 * 60 * 60;
const KEY_PATH = '/__cache/github-releases.json';

/**
 * The release list for the guide: fresh from GitHub when that works, otherwise
 * the last list that worked in this colo, otherwise empty. Never throws.
 */
export async function releasesWithFallback(origin: string): Promise<ReleaseItem[]> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = new URL(KEY_PATH, origin).toString();
  const fresh = await fetchReleases();

  if (fresh) {
    // The page cache in front of this render keeps writes rare. The write runs
    // after the response is sent.
    if (fresh.length > 0) {
      const body = Response.json(fresh, { headers: { 'Cache-Control': `max-age=${KEEP_SECONDS}` } });
      waitUntil(cache.put(key, body).catch(() => {}));
    }
    return fresh;
  }

  try {
    const stored = await cache.match(key);
    return stored ? ((await stored.json()) as ReleaseItem[]) : [];
  } catch {
    return [];
  }
}
