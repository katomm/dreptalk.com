// The homepage banner shows the newest GitHub release next to the open-source
// message. Releases follow a convention: the human title lives in the release
// name as "vX.Y.Z <title>", and a "## Summary" section opens the body with a
// one-paragraph recap. We pull the version, title, first summary sentence, date
// and link, and degrade to null (banner shows the open-source side only) on any
// problem, so a slow or down GitHub never blocks or breaks the page.

import { fetchWithTimeout, type FetchWithTimeoutInit } from '@/lib/http/fetchWithTimeout.js';

// Base REST path for this repo's releases; the banner appends "/latest", the
// listing fetches the collection.
export const GITHUB_RELEASES_URL = 'https://api.github.com/repos/katomm/dreptalk.com/releases';
const LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`;

// Below this many milliseconds a release is treated as current; past it the
// right side is dropped so an abandoned-looking banner never lingers.
const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export interface LatestRelease {
  version: string; // tag, e.g. "v1.0.0"
  title: string; // human title with the tag stripped ("" if the name is only the tag)
  summary: string; // first sentence of the release summary ("" if none)
  url: string; // link to the release page
  publishedAtMs: number;
}

// Only the fields we consume from GitHub's release payload. Shared with the
// release listing, which extends it with draft/prerelease.
export interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
}

/**
 * Shared request setup for this repo's GitHub release calls: a short timeout, the
 * required User-Agent, and Cloudflare edge caching so a slow or down GitHub never
 * blocks render (the origin is hit at most about once per hour per colo).
 */
export function githubReleaseFetchInit(): FetchWithTimeoutInit & {
  cf: { cacheTtl: number; cacheEverything: boolean };
} {
  return {
    timeoutMs: 3000,
    headers: {
      // GitHub rejects requests without a User-Agent.
      'User-Agent': 'dreptalk.com',
      Accept: 'application/vnd.github+json',
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  };
}

/**
 * The human title lives in the release name as "vX.Y.Z <title>". Strip the
 * leading tag (and any separator after it) so the version is not shown twice.
 * Returns the name unchanged if it does not start with the tag.
 */
export function releaseTitle(name: string, tag: string): string {
  const n = (name ?? '').trim();
  const t = (tag ?? '').trim();
  if (t && n.toLowerCase().startsWith(t.toLowerCase())) {
    // Drop the tag plus a following separator: space, colon, middot, dash.
    return n.slice(t.length).replace(/^[\s:\u00b7\u2013\u2014-]+/, '').trim();
  }
  return n;
}

/**
 * First sentence of the release summary, cleaned of markup. Prefers the
 * "## Summary" section; if the heading is missing, falls back to the first
 * prose paragraph so a forgotten heading never breaks the banner. Returns ""
 * when there is no prose (e.g. an image-only summary or an empty body).
 */
export function releaseSummary(body: string): string {
  const clean = cleanProse(summaryBlock(body ?? ''));
  return clean ? firstSentence(clean) : '';
}

/**
 * The whole cleaned summary paragraph (not just the first sentence). Used by the
 * roomier release listing, where there is space for the full recap. Same source
 * and fallbacks as releaseSummary; returns "" when there is no prose.
 */
export function releaseSummaryFull(body: string): string {
  return cleanProse(summaryBlock(body ?? ''));
}

/**
 * Turn a raw GitHub release payload into the banner view model, or null when
 * there is nothing worth showing: missing tag/url, an unparseable date, or a
 * release older than the staleness window.
 */
export function parseRelease(raw: GitHubReleasePayload, nowMs: number): LatestRelease | null {
  const version = (raw?.tag_name ?? '').trim();
  const url = (raw?.html_url ?? '').trim();
  if (!version || !url) return null;

  const publishedAtMs = Date.parse(raw?.published_at ?? '');
  if (!Number.isFinite(publishedAtMs)) return null;
  if (nowMs - publishedAtMs > STALE_AFTER_MS) return null;

  return {
    version,
    title: releaseTitle(raw?.name ?? '', version),
    summary: releaseSummary(raw?.body ?? ''),
    url,
    publishedAtMs,
  };
}

/**
 * Fetch the newest release from GitHub, edge-cached so the homepage hits the
 * API at most about once per hour per colo. Never throws: any failure (non-2xx,
 * timeout, parse error, stale release) resolves to null.
 */
export async function fetchLatestRelease(nowMs: number): Promise<LatestRelease | null> {
  try {
    const res = await fetchWithTimeout(LATEST_RELEASE_URL, githubReleaseFetchInit());
    if (!res.ok) return null;
    const raw = (await res.json()) as GitHubReleasePayload;
    return parseRelease(raw, nowMs);
  } catch {
    return null;
  }
}

// --- internals -------------------------------------------------------------

/** Isolate the first prose paragraph of the summary from the release body. */
function summaryBlock(body: string): string {
  let text = body.replace(/\r\n/g, '\n');
  // Drop a leading "## Summary" heading when the author used one.
  text = text.replace(/^\s*#{1,6}\s*summary\s*\n/i, '');
  // Cut at the next markdown heading (e.g. "## What's Changed").
  const nextHeading = text.search(/\n#{1,6}\s/);
  if (nextHeading !== -1) text = text.slice(0, nextHeading);
  // Keep only the first non-empty paragraph (images sit in their own paragraph).
  return (
    text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p.length > 0) ?? ''
  );
}

/** Strip HTML tags and markdown markup, leaving link text, and collapse space. */
function cleanProse(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ') // html tags such as <img>
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // markdown images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown links to their text
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/[*_`>]+/g, '') // emphasis, code, quote markers
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First sentence of a cleaned string. A sentence ends at .!? only when followed
 * by whitespace and a sentence-starting character, so decimals like "1.0" do
 * not split the sentence early. Returns the whole string if no boundary is found.
 */
function firstSentence(s: string): string {
  const m = s.match(/^(.*?[.!?])(\s+["'\u201c(A-Z]|$)/);
  return (m ? m[1] : s).trim();
}
