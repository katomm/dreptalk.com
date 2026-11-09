import { afterEach, describe, expect, it, vi } from 'vitest';
import { releasesWithFallback } from './lastGoodReleases.js';

const ORIGIN = 'https://last-good.example';

function githubRelease(tag: string, publishedAt: string) {
  return {
    tag_name: tag,
    name: `${tag} Title`,
    body: '## Summary\nA recap.\n\n## What\'s Changed',
    html_url: `https://github.com/katomm/dreptalk.com/releases/tag/${tag}`,
    published_at: publishedAt,
  };
}

// The stored copy is written in waitUntil, after the call returns. Poll briefly.
async function storedVersions(): Promise<string[] | null> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  for (let i = 0; i < 50; i++) {
    const hit = await cache.match(`${ORIGIN}/__cache/github-releases.json`);
    if (hit) return ((await hit.json()) as { version: string }[]).map((r) => r.version);
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

afterEach(() => vi.restoreAllMocks());

describe('releasesWithFallback', () => {
  it('shows the last good list when GitHub fails, and nothing before one exists', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // No stored list yet: a failure renders an empty list.
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 403 }));
    expect(await releasesWithFallback(ORIGIN)).toEqual([]);

    // A good answer from GitHub is returned and stored.
    fetchSpy.mockResolvedValueOnce(
      Response.json([
        githubRelease('v1.0.0', '2026-01-01T00:00:00Z'),
        githubRelease('v1.1.0', '2026-02-01T00:00:00Z'),
      ]),
    );
    const fresh = await releasesWithFallback(ORIGIN);
    expect(fresh.map((r) => r.version)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(await storedVersions()).toEqual(['v1.1.0', 'v1.0.0']);

    // GitHub fails again: the stored list stands in.
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 403 }));
    const fallback = await releasesWithFallback(ORIGIN);
    expect(fallback.map((r) => r.version)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(fallback[0].title).toBe('Title');

    // A thrown fetch (timeout, network) falls back the same way.
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    expect((await releasesWithFallback(ORIGIN)).map((r) => r.version)).toEqual(['v1.1.0', 'v1.0.0']);
  });
});
