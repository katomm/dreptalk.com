// The "What's new" guide lists every GitHub release, newest first, with more room
// than the homepage banner: each entry keeps the full "## Summary" paragraph, not
// just its first sentence. We reuse the banner's title/summary parsing and degrade
// to an empty list (the guide simply renders no list) on any problem, so a slow or
// down GitHub never blocks or breaks the page.

import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import {
  GITHUB_RELEASES_URL,
  type GitHubReleasePayload,
  githubReleaseFetchInit,
  releaseSummaryFull,
  releaseTitle,
} from './latestRelease.js';

// How many releases to request; the history is small, so one page covers it.
const PER_PAGE = 30;

export interface ReleaseItem {
  version: string; // tag, e.g. "v1.0.0"
  title: string; // human title with the tag stripped ("" if the name is only the tag)
  summary: string; // full summary paragraph ("" if none)
  url: string; // link to the release page
  publishedAtMs: number;
}

// The listing also reads the publish flags to skip drafts and prereleases.
interface ReleaseListPayload extends GitHubReleasePayload {
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Turn one raw GitHub release into a list item, or null when it should not be
 * listed: a draft, a prerelease, or missing tag/url/date. Unlike the banner there
 * is no staleness filter, since the listing is a full history.
 */
export function parseReleaseItem(raw: ReleaseListPayload): ReleaseItem | null {
  if (raw?.draft || raw?.prerelease) return null;

  const version = (raw?.tag_name ?? '').trim();
  const url = (raw?.html_url ?? '').trim();
  if (!version || !url) return null;

  const publishedAtMs = Date.parse(raw?.published_at ?? '');
  if (!Number.isFinite(publishedAtMs)) return null;

  return {
    version,
    title: releaseTitle(raw?.name ?? '', version),
    summary: releaseSummaryFull(raw?.body ?? ''),
    url,
    publishedAtMs,
  };
}

/**
 * Fetch the newest releases from GitHub, edge-cached so the guide hits the API at
 * most about once per hour per colo. Never throws: any failure (non-2xx, timeout,
 * parse error) resolves to an empty array. Results are newest first.
 */
export async function fetchReleases(): Promise<ReleaseItem[]> {
  try {
    const url = `${GITHUB_RELEASES_URL}?per_page=${PER_PAGE}`;
    const res = await fetchWithTimeout(url, githubReleaseFetchInit());
    if (!res.ok) return [];
    const raw = (await res.json()) as ReleaseListPayload[];
    return raw
      .map(parseReleaseItem)
      .filter((r): r is ReleaseItem => r !== null)
      .sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  } catch {
    return [];
  }
}
